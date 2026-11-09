/**
 * /merge 与 /branches 命令。
 *
 * /merge [#序号|标题|id] [summary|full|last|N轮] [--all] [--wake] [-- 附言]
 *   - 不带分支：有分支时合并那个有新内容的分支（拿不准就列出来让你选）；
 *     本身是分支且没有子分支时，把自己合并到父会话（--up 总是这样做）。
 *   - 默认静默并入：摘要随你的下一条消息一起交给 agent；--wake 立刻唤醒；
 *     写了附言就把附言作为你的消息发出去（也会唤醒）。
 *   - --all 忽略上次合并的位置，从分叉点重新整理。
 * /branches 打印会话地图。
 */

import { createT, pickLocale } from './i18n.js'
import { branchStatus, collectMap, renderCandidates, renderMap } from './map.js'
import { MergeError, canSendNote, deliver, mergeMessage, mergesOf, prepareMerge, reasonOf, resolveTargetAgent, sendNote } from './merge.js'
import { textOf } from './util.js'

const SCOPE_WORDS = new Map([
  ['summary', 'summary'], ['摘要', 'summary'],
  ['full', 'full'], ['完整', 'full'], ['全部', 'full'],
  ['last', 'last'], ['最后', 'last'], ['结论', 'last']
])
const TOKEN = /"([^"]*)"|'([^']*)'|「([^」]*)」|“([^”]*)”|(\S+)/gu

function tokenize(text) {
  const tokens = []
  for (const match of text.matchAll(TOKEN)) tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])
  return tokens.filter((token) => token !== '')
}

/** 解析 /merge 的参数；遇到不认识的选项返回 { error }。 */
export function parseMergeInput(raw) {
  const text = String(raw ?? '').trim()
  const separator = /(?:^|\s)--(?:\s+|$)/u.exec(text)
  const head = separator === null ? text : text.slice(0, separator.index)
  const note = separator === null ? '' : text.slice(separator.index + separator[0].length).trim()
  const options = { query: '', scope: 'summary', turns: undefined, wake: false, fresh: false, up: false, note }
  const words = []
  for (const token of tokenize(head)) {
    const lower = token.toLowerCase()
    if (lower === '--wake' || lower === '-w') options.wake = true
    else if (lower === '--all' || lower === '-a') options.fresh = true
    else if (lower === '--up' || lower === '-u') options.up = true
    else if (SCOPE_WORDS.has(lower)) options.scope = SCOPE_WORDS.get(lower)
    else if (/^(?:turns?[:=])\d+$|^\d+(?:轮|turns?)$/u.test(lower)) options.turns = Number(/\d+/u.exec(lower)[0])
    else if (/^\d{1,3}$/u.test(lower) && words.length === 0) words.push(`#${lower}`)
    else if (lower.startsWith('-') && lower.length > 1) return { error: token }
    else words.push(token)
  }
  options.query = words.join(' ')
  if (options.turns !== undefined && options.turns < 1) return { error: head }
  return options
}

/** 选文案语言：配置优先，其次看会话标题和最近的用户输入里有没有中文。 */
export function localeFor(env, sessionIds, agent) {
  const samples = sessionIds.map((id) => env.lineage.snapshotOf(id).title).filter(Boolean)
  if (agent?.session !== undefined && env.config.locale === 'auto' && samples.length === 0) {
    try {
      const session = agent.session
      for (const event of session.snapshotEvents(Math.max(session.inheritedEventCount, session.seq - 400))) {
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') samples.push(textOf(event.data.content).slice(0, 200))
      }
    } catch {
      // 读不到最近的输入就按区域设置
    }
  }
  return createT(pickLocale(env.config.locale, samples))
}

function ok(text) {
  return { kind: 'success', text }
}

function fail(text) {
  return { kind: 'error', text }
}

function rangeText(t, stats) {
  if (stats.fromTurn === null) return ''
  return stats.fromTurn === stats.toTurn ? t('rangeSingle', { turn: stats.fromTurn }) : t('rangeShort', { from: stats.fromTurn, to: stats.toTurn })
}

function statsText(t, stats, chars) {
  const parts = []
  if (stats.turnCount > 0) parts.push(t('statTurns', { count: stats.turnCount }))
  if (stats.files.length > 0) parts.push(t('statFiles', { count: stats.files.length }))
  if (stats.commandCount > 0) parts.push(t('statCommands', { count: stats.commandCount }))
  if (stats.decisions > 0) parts.push(t('statDecisions', { count: stats.decisions }))
  parts.push(t('statChars', { count: chars }))
  return t('statsLine', { parts: parts.join(t('listSeparator')) })
}

/** 决定这次合并的来源与目标。返回 { result } 表示直接结束（列表、提示），否则 { sourceId, push }。 */
async function pickSource(env, t, agent, input) {
  const { lineage } = env
  const selfId = agent.id
  const self = lineage.get(selfId)
  const parentId = self?.parent
  if (input.up) {
    if (parentId === undefined || self.subagent) return { result: ok(t('noParent')) }
    return { sourceId: selfId, push: true }
  }
  if (input.query === '') {
    const children = lineage.childrenOf(selfId)
    if (children.length === 1) return { sourceId: children[0].id, push: false }
    if (children.length > 1) {
      // 多个分支里只有一个有未合并的新内容时，直接合并它
      const data = await collectMap(lineage, selfId, { exact: true })
      const entries = data.tree.entries.filter((entry) => entry.parentId === selfId)
      const statuses = entries.map((entry) => branchStatus(entry, data.snapshots))
      const waiting = entries.filter((_entry, index) => !statuses[index].known || statuses[index].unmerged > 0)
      if (waiting.length === 1 && statuses[entries.indexOf(waiting[0])].known) return { sourceId: waiting[0].node.id, push: false }
      return { result: ok(t('chooseBranch', { list: renderCandidates(t, data, entries) })) }
    }
    if (parentId !== undefined && !self.subagent) return { sourceId: selfId, push: true }
    return { result: ok(t('noBranches')) }
  }
  const resolved = lineage.resolve(input.query, selfId)
  if (resolved.match !== undefined) return { sourceId: resolved.match.node.id, push: false }
  if (resolved.outside !== undefined) return { result: fail(t('unrelated', { title: lineage.label(resolved.outside.id, t('untitled')) })) }
  const data = await collectMap(lineage, selfId, { exact: false })
  const ambiguous = resolved.candidates.length > 1
  const list = renderCandidates(t, data, ambiguous ? resolved.candidates : data.tree.entries)
  return { result: fail(t(ambiguous ? 'ambiguous' : 'notFound', { query: input.query, list })) }
}

export async function runMerge(env, invocation) {
  const { lineage } = env
  const agent = invocation.agent
  await lineage.ensure(2_000)
  let t = localeFor(env, [agent.id], agent)
  const input = parseMergeInput(invocation.rawInput)
  if (input.error !== undefined) return fail(`${t('unknownOption', { option: input.error })}\n${t('parseHint')}`)
  try {
    const picked = await pickSource(env, t, agent, input)
    if (picked.result !== undefined) return picked.result
    const { sourceId, push } = picked
    t = localeFor(env, [agent.id, sourceId], agent)
    const target = push ? await resolveTargetAgent(env, lineage.get(agent.id).parent, t) : agent
    const separateNote = !push && input.note !== '' && canSendNote(env)
    const prepared = await prepareMerge({ ...env, t }, {
      sourceId,
      targetId: target.id,
      targetMerges: mergesOf(env.ctx, target.session),
      scope: input.scope,
      turns: input.turns,
      fresh: input.fresh,
      note: separateNote ? undefined : input.note,
      signal: invocation.signal
    })
    if (prepared.empty) {
      // 合并已经在排队、用户又写了附言：照样发出附言，排队的合并会随它一起交给 agent
      if (separateNote && prepared.previous?.pending === true) {
        await sendNote(env, target, input.note, invocation.signal)
        return ok(t('noteWithQueued', { title: prepared.title, turn: prepared.previous.turn }))
      }
      const nothing = prepared.previous !== undefined
        ? t('nothingNew', { title: prepared.title, turn: prepared.previous.turn })
        : t('nothingAtAll', { title: prepared.title })
      return ok(input.note === '' ? nothing : `${nothing}\n${t('noteNotSent')}`)
    }
    const mode = await deliver(env, target, mergeMessage(prepared), {
      wake: input.wake,
      note: separateNote ? input.note : undefined,
      signal: invocation.signal
    })
    const params = {
      title: prepared.title,
      range: rangeText(t, prepared.digest.stats),
      target: lineage.label(target.id, t('untitled'))
    }
    const key = push
      ? (mode === 'silent' ? 'mergedInto' : 'mergedIntoWake')
      : mode === 'note' ? 'mergedNote' : mode === 'wake' ? 'mergedWake' : 'mergedSilent'
    const lines = [t(key, params), statsText(t, prepared.digest.stats, prepared.digest.text.length)]
    if (prepared.previous !== undefined && !input.fresh) lines.push(t('incrementalHint'))
    return ok(lines.join('\n'))
  } catch (error) {
    if (error instanceof MergeError) return fail(t(error.key, error.params))
    if (invocation.signal?.aborted) return fail(t('cancelled'))
    return fail(t('unexpected', { reason: reasonOf(error) }))
  }
}

export async function runBranches(env, invocation) {
  const agent = invocation.agent
  await env.lineage.ensure(2_000)
  const t = localeFor(env, [agent.id], agent)
  try {
    const data = await collectMap(env.lineage, agent.id, { exact: true })
    return ok(renderMap(t, data))
  } catch (error) {
    return fail(t('unexpected', { reason: reasonOf(error) }))
  }
}

/** 注册命令。描述是给命令面板看的，中英双语。 */
export function registerCommands(ctx, env) {
  ctx.commands.register({
    definitionId: 'dsh-session-git/merge',
    name: 'merge',
    description: '合并分支会话的工作 · Merge a forked session’s work',
    input: { hint: '[#序号|标题] [summary|full|last|N轮] [--wake] [-- 附言]' },
    handler: (invocation) => runMerge(env, invocation)
  })
  ctx.commands.register({
    definitionId: 'dsh-session-git/branches',
    name: 'branches',
    description: '查看会话地图（分支与合并状态）· Show the session map',
    handler: (invocation) => runBranches(env, invocation)
  })
}
