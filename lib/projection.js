/**
 * sessionGit 会话投影：从每个会话自己的日志里折叠出「分叉点、轮次进度、合并记录」。
 *
 * - 日志是唯一事实来源：合并记录就是目标会话里 source.kind 为 session-git 的 user 消息，
 *   或 session_branch_merge 工具结果 meta 里的 sessionGit 字段；
 *   还没被 agent 接纳的合并（在收件箱里排队）从 agent/inbox/spliced 事件里跟踪。
 * - apply 对无关事件返回同一个引用；view 按内容复用对象，内容不变就不会向客户端推送。
 * - apply 绝不抛错：它在每个会话的每个事件上运行。
 */

import { MERGE_FORMAT, PROJECTION_KEY, SOURCE_KIND } from './util.js'

/** 状态字段或折叠语义变化时递增。 */
export const STATE_VERSION = 1

const TARGETS = ['next-turn', 'next-step']

/**
 * 初始状态。inheritedEventCount 是 fork 时复制的事件数（根会话为 0）；
 * born 是创建时间，客户端按它给分支编号，和 Host 的 #序号一致。
 */
export function initState(header, inheritedEventCount) {
  const cut = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0
  return {
    cut,
    born: Number.isSafeInteger(header?.createdAt) ? header.createdAt : 0,
    forkTurn: 0,
    turn: 0,
    doneTurn: 0,
    doneSeq: -1,
    merges: {},
    inbox: { 'next-turn': [], 'next-step': [] },
    pending: {}
  }
}

/** 校验合并元数据（source.merge 或工具结果的 meta.sessionGit）；不合格返回 null。 */
export function mergeMetaFrom(merge) {
  if (merge === null || typeof merge !== 'object') return null
  if (typeof merge.from !== 'string' || merge.from === '' || !Number.isSafeInteger(merge.through)) return null
  return {
    from: merge.from,
    through: merge.through,
    turn: Number.isSafeInteger(merge.turn) ? merge.turn : 0
  }
}

/** 从一条消息上读出合并元数据；不是合并消息就返回 null。 */
export function mergeMetaOf(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object' || source.kind !== SOURCE_KIND) return null
  return mergeMetaFrom(source.merge)
}

/** 合并记录里保留较新的那次。 */
function mergeEntry(previous, meta, at) {
  return {
    through: Math.max(previous?.through ?? -1, meta.through),
    turn: Math.max(previous?.turn ?? 0, meta.turn),
    at,
    n: (previous?.n ?? 0) + 1
  }
}

function applyTurnStart(state, event) {
  const turn = event.data?.turn
  if (!Number.isSafeInteger(turn)) return state
  const latest = Math.max(state.turn, turn)
  const forkTurn = event.seq < state.cut ? Math.max(state.forkTurn, turn) : state.forkTurn
  if (latest === state.turn && forkTurn === state.forkTurn) return state
  return { ...state, turn: latest, forkTurn }
}

function applyTurnEnd(state, event) {
  const turn = event.data?.turn
  if (!Number.isSafeInteger(turn)) return state
  return { ...state, doneTurn: Math.max(state.doneTurn, turn), doneSeq: event.seq }
}

function applyInboxSplice(state, event) {
  const data = event.data
  const target = data?.target
  if (!TARGETS.includes(target)) return state
  const inserted = Array.isArray(data.inserted) ? data.inserted : []
  const start = Number.isSafeInteger(data.start) && data.start >= 0 ? data.start : 0
  const removedCount = Number.isSafeInteger(data.removedCount) && data.removedCount > 0 ? data.removedCount : 0
  if (inserted.length === 0 && removedCount === 0) return state

  const list = state.inbox[target].slice()
  const removed = list.splice(start, removedCount, ...inserted.map((message) => (typeof message?.id === 'string' ? message.id : '')))
  let pending = state.pending
  const editable = () => {
    if (pending === state.pending) pending = { ...state.pending }
    return pending
  }
  for (const id of removed) {
    if (id !== '' && Object.hasOwn(pending, id)) delete editable()[id]
  }
  for (const message of inserted) {
    const meta = mergeMetaOf(message)
    if (meta !== null && typeof message.id === 'string') editable()[message.id] = { ...meta, at: event.time }
  }
  return { ...state, inbox: { ...state.inbox, [target]: list }, pending }
}

function applyUserMessage(state, event) {
  const meta = mergeMetaOf(event.data)
  if (meta === null) return state
  const merges = { ...state.merges, [meta.from]: mergeEntry(state.merges[meta.from], meta, event.time) }
  let pending = state.pending
  const id = event.data?.id
  if (typeof id === 'string' && Object.hasOwn(pending, id)) {
    pending = { ...pending }
    delete pending[id]
  }
  return { ...state, merges, pending }
}

/** 模型通过 session_branch_merge 工具合并时，记录在工具结果的 meta 里。 */
function applyToolResult(state, event) {
  const meta = mergeMetaFrom(event.data?.meta?.[PROJECTION_KEY])
  if (meta === null) return state
  return { ...state, merges: { ...state.merges, [meta.from]: mergeEntry(state.merges[meta.from], meta, event.time) } }
}

/** 纯函数折叠：对无关事件返回同一个引用。 */
export function applyEvent(state, event) {
  try {
    switch (event?.type) {
      case 'turn/start': return applyTurnStart(state, event)
      case 'turn/end': return applyTurnEnd(state, event)
      case 'agent/inbox/spliced': return applyInboxSplice(state, event)
      case 'user/message': return applyUserMessage(state, event)
      case 'tool/result': return applyToolResult(state, event)
      default: return state
    }
  } catch {
    return state
  }
}

/** 已接纳 + 排队中的合并，合成「最近一次合并」。 */
export function effectiveMerges(state) {
  const result = {}
  for (const [from, entry] of Object.entries(state.merges)) result[from] = { ...entry, pending: false }
  for (const meta of Object.values(state.pending)) {
    const previous = result[meta.from]
    if (previous !== undefined && previous.through >= meta.through) continue
    result[meta.from] = {
      through: meta.through,
      turn: Math.max(previous?.turn ?? 0, meta.turn),
      at: meta.at,
      n: (previous?.n ?? 0) + 1,
      pending: true
    }
  }
  return result
}

const viewCache = new Map()
const VIEW_CACHE_LIMIT = 1000

/** 内容相同就复用同一个对象，避免投影注册表向客户端重复推送。 */
function stable(value) {
  const key = JSON.stringify(value)
  const cached = viewCache.get(key)
  if (cached !== undefined) return cached
  if (viewCache.size >= VIEW_CACHE_LIMIT) viewCache.delete(viewCache.keys().next().value)
  viewCache.set(key, value)
  return value
}

/** 客户端看到的视图。 */
export function viewOf(state) {
  return stable({
    v: MERGE_FORMAT,
    cut: state.cut,
    born: state.born,
    forkTurn: state.forkTurn,
    turn: state.turn,
    doneTurn: state.doneTurn,
    merges: effectiveMerges(state)
  })
}

function isInt(value) {
  return Number.isSafeInteger(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkMergeEntry(entry) {
  return isRecord(entry) && isInt(entry.through) && isInt(entry.turn) && typeof entry.at === 'number'
}

/** 最小的 schema 对象：投影注册表只调用 parse。 */
export const stateSchema = {
  parse(value) {
    const ok = isRecord(value)
      && isInt(value.cut) && isInt(value.born) && isInt(value.forkTurn) && isInt(value.turn) && isInt(value.doneTurn) && isInt(value.doneSeq)
      && isRecord(value.merges) && Object.values(value.merges).every((entry) => checkMergeEntry(entry) && isInt(entry.n))
      && isRecord(value.inbox) && TARGETS.every((target) => Array.isArray(value.inbox[target]) && value.inbox[target].every((id) => typeof id === 'string'))
      && isRecord(value.pending) && Object.values(value.pending).every((meta) => checkMergeEntry(meta) && typeof meta.from === 'string')
    if (!ok) throw new TypeError(`${PROJECTION_KEY}: invalid projection state`)
    return value
  }
}

export const viewSchema = {
  parse(value) {
    const ok = isRecord(value) && isInt(value.cut) && isInt(value.born) && isInt(value.forkTurn) && isInt(value.turn) && isInt(value.doneTurn) && isRecord(value.merges)
    if (!ok) throw new TypeError(`${PROJECTION_KEY}: invalid projection view`)
    return value
  }
}

/** 注册到 ctx.sessionProjections 的定义。 */
export const projectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema,
  init: initState,
  apply: applyEvent,
  wire: { viewSchema, view: viewOf }
}

/** 在一段事件上从头折叠（用于测试，以及没有缓存时的冷读）。 */
export function foldEvents(events, inheritedEventCount, header) {
  let state = initState(header, inheritedEventCount)
  for (const event of events) state = applyEvent(state, event)
  return state
}
