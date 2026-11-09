/**
 * 合并：把源会话分叉之后（或上次合并之后）的工作整理成摘要，投递给目标会话。
 *
 * 不复制任何事件，只往目标会话写一条 source.kind = session-git 的上下文消息；
 * 这条消息本身就是合并记录（见 projection.js），不需要额外存储。
 */

import { randomUUID } from 'node:crypto'
import { buildDigest } from './digest.js'
import { effectiveMerges } from './projection.js'
import { MERGE_FORMAT, PROJECTION_KEY, SOURCE_KIND, createUserMessage, shortId } from './util.js'

/** 预期内的失败，key 是 i18n 文案键。 */
export class MergeError extends Error {
  constructor(key, params = {}) {
    super(key)
    this.name = 'MergeError'
    this.key = key
    this.params = params
  }
}

export function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读源会话的完整事件。observeSession 带预备会话缓存，连续合并同一个分支时更省。 */
export async function readSource(ctx, id, signal) {
  const query = ctx.sessionQuery
  if (typeof query.observeSession === 'function') {
    const lease = await query.observeSession(id, { signal, projectionMode: 'none' })
    try {
      return { header: lease.header, inheritedEventCount: lease.inheritedEventCount, events: lease.events }
    } finally {
      lease[Symbol.dispose]?.()
    }
  }
  const read = await query.readSession(id)
  return { header: read.session, inheritedEventCount: read.inheritedEventCount, events: read.events }
}

/** 已经结束的最大轮次号。 */
function completedTurn(events) {
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)) turn = Math.max(turn, event.data.turn)
  }
  return turn
}

/** seq 之前开始过的最大轮次号（共享历史里有几轮）。 */
function turnsBefore(events, seq) {
  let turn = 0
  for (const event of events) {
    if (event.seq >= seq) break
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = Math.max(turn, event.data.turn)
  }
  return turn
}

function titleFromEvents(events) {
  let title
  for (const event of events) {
    const value = event.type === 'session/title' ? event.data?.title : undefined
    if (typeof value === 'string' && value.trim() !== '') title = value.trim()
  }
  return title
}

/** 目标会话里关于各个来源的合并记录（含排队中的）。 */
export function mergesOf(ctx, session) {
  if (session === undefined) return {}
  try {
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    return state === undefined ? {} : effectiveMerges(state)
  } catch {
    return {}
  }
}

/**
 * 生成一次合并（还不投递）。
 * @param {object} env { ctx, lineage, config, t }
 * @param {object} request
 * @param {string} request.sourceId 要合并进来的会话
 * @param {string} request.targetId 接收合并的会话
 * @param {object} [request.targetMerges] 目标会话已有的合并记录（mergesOf 的结果）
 * @param {'summary'|'full'|'last'} [request.scope]
 * @param {number} [request.turns] 只要最近几轮
 * @param {boolean} [request.fresh] 忽略上次合并，从分叉点重新整理
 * @param {string} [request.note] 写进摘要的附言（无法单独发消息时用）
 */
export async function prepareMerge(env, request) {
  const { ctx, lineage, config, t } = env
  const { sourceId, targetId, targetMerges = {}, scope = 'summary', turns, fresh = false, note, signal } = request
  if (sourceId === targetId) throw new MergeError('self')
  await lineage.ensure()
  const label = lineage.label(sourceId, t('untitled'))
  const relation = lineage.relation(sourceId, targetId)
  if (relation === null) throw new MergeError('unrelated', { title: label })

  let source
  try {
    source = await readSource(ctx, sourceId, signal)
  } catch (error) {
    throw new MergeError('readFailed', { title: label, reason: reasonOf(error) })
  }
  lineage.rememberCut(sourceId, source.inheritedEventCount)
  const common = await lineage.commonPrefix(sourceId, targetId)
  if (common === null) throw new MergeError('unrelated', { title: label })

  const prefix = Number.isFinite(common.prefix) ? common.prefix : 0
  const previous = fresh ? undefined : targetMerges[sourceId]
  const start = Math.max(prefix, previous === undefined ? 0 : previous.through + 1)
  const title = lineage.snapshotOf(sourceId).title ?? titleFromEvents(source.events) ?? t('untitled')
  const relationKey = relation === 'child' ? 'relationChild' : relation === 'parent' ? 'relationParent' : 'relationOther'
  const sourceCwd = source.header?.cwd
  const targetCwd = lineage.get(targetId)?.cwd
  const workspaceChanges = ctx.get('workspaceChanges')
  const scopeName = Number.isSafeInteger(turns) && turns > 0 ? `turns:${turns}` : scope

  const digest = buildDigest({
    t,
    events: source.events,
    start,
    scope,
    turns,
    note,
    maxChars: config.maxDigestChars,
    id: sourceId,
    title,
    relationText: t(relationKey, { title, id: shortId(sourceId), turn: turnsBefore(source.events, prefix) }),
    previousTurn: previous !== undefined && previous.turn > 0 ? previous.turn : undefined,
    cwd: sourceCwd,
    cwdNote: typeof sourceCwd === 'string' && typeof targetCwd === 'string' && sourceCwd !== targetCwd ? t('cwdDiffers', { cwd: sourceCwd }) : '',
    titleOf: (id) => lineage.label(id, t('untitled')),
    workspaceChanges: typeof workspaceChanges?.summary === 'function' ? (seq) => workspaceChanges.summary(sourceId, seq) : undefined
  })

  const result = { sourceId, targetId, title, relation, previous, start, digest }
  if (digest.stats.empty) return { ...result, empty: true }
  return {
    ...result,
    empty: false,
    merge: {
      v: MERGE_FORMAT,
      from: sourceId,
      title,
      through: digest.stats.lastSeq,
      turn: completedTurn(source.events),
      since: start,
      scope: scopeName
    }
  }
}

/** 合并消息：聊天里显示成可折叠的「上下文注入」卡片，标题是 summary。 */
export function mergeMessage(prepared) {
  return createUserMessage([{ type: 'text', text: prepared.digest.text }], {
    kind: SOURCE_KIND,
    form: 'notice',
    summary: prepared.digest.summary,
    merge: prepared.merge
  })
}

/**
 * 投递到目标 agent。
 * - 默认 inject：排进下一步、不唤醒；agent 空闲时随用户的下一条消息一起被领取。
 * - wake：followup，立刻开始新的一轮。
 * - 附言：先 inject 摘要，再把附言作为用户消息发出（会唤醒）。收件箱先领取全部
 *   next-step 再领取一条 next-turn，所以摘要一定排在附言前面。
 * @returns {'silent'|'wake'|'note'}
 */
export async function deliver(env, agent, message, options = {}) {
  const note = typeof options.note === 'string' ? options.note.trim() : ''
  if (note !== '' && canSendNote(env)) {
    agent.inject(message)
    await sendNote(env, agent, note, options.signal)
    return 'note'
  }
  if (options.wake === true || note !== '') {
    agent.followup(message)
    return 'wake'
  }
  agent.inject(message)
  return 'silent'
}

/** 把附言作为用户自己的一条消息发出（会唤醒 agent，排队中的合并随它一起交付）。 */
export async function sendNote(env, agent, note, signal) {
  const controller = env.ctx.get('sessionController')
  await controller.prompt({ sessionId: agent.id, content: [{ type: 'text', text: note }], requestId: randomUUID() }, signal ?? AbortSignal.timeout(30_000))
}

/** 附言能否作为单独的用户消息发出；不能时要写进摘要里。 */
export function canSendNote(env) {
  return typeof env.ctx.get('sessionController')?.prompt === 'function'
}

/** 解析出目标会话的 agent（推送到父会话时用）。 */
export async function resolveTargetAgent(env, sessionId, t) {
  const live = env.ctx.get('agents')?.get?.(sessionId)
  const controller = env.ctx.get('sessionController')
  const title = env.lineage.label(sessionId, t('untitled'))
  if (env.lineage.get(sessionId)?.subagent) throw new MergeError('targetSubagent', { target: title })
  if (controller === undefined || typeof controller.resolveAgent !== 'function') {
    if (live !== undefined) return live
    throw new MergeError('pushUnavailable', { target: title, id: shortId(sessionId) })
  }
  let resolved
  try {
    resolved = await controller.resolveAgent(sessionId)
  } catch (error) {
    throw new MergeError('targetRejected', { target: title, reason: reasonOf(error) })
  }
  if (resolved?.agent !== undefined) return resolved.agent
  throw new MergeError('targetRejected', { target: title, reason: reasonOf(resolved?.error ?? 'unknown error') })
}
