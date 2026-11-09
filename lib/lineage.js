/**
 * 会话血缘：谁从谁分叉、在第几个事件处分叉、两个会话共享多长的历史。
 *
 * - 头部列表来自 sessionQuery.listSessions（不读日志，开销很小），按 TTL 缓存；
 *   新建的会话通过 session/created 立刻补进来。
 * - 切点（inheritedEventCount）在 fork 时就固定了，算过一次就一直缓存。
 * - 标题和 sessionGit 视图：存活会话读投影注册表，冷会话读投影缓存（零 I/O），
 *   都没有时才回退到读整份日志。
 */

import { PROJECTION_KEY, shortId } from './util.js'
import { foldEvents, viewOf } from './projection.js'

const DEFAULT_TTL_MS = 15_000
const SNAPSHOT_KEYS = ['title', PROJECTION_KEY]
const ID_PREFIX_MIN = 4

function nodeOf(header, live) {
  const parent = typeof header.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : undefined
  return {
    id: header.id,
    parent,
    subagent: header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
    header,
    live
  }
}

function byCreation(a, b) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function bareId(id) {
  return String(id).replace(/^session-/u, '').toLowerCase()
}

export class LineageIndex {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.nodes = new Map()
    this.children = undefined
    this.cuts = new Map()
    this.loadedAt = 0
    this.inflight = undefined
  }

  /** 重新列出所有会话的头部。 */
  async refresh() {
    const records = await this.ctx.sessionQuery.listSessions()
    const nodes = new Map()
    for (const record of records) {
      const header = record?.header
      if (typeof header?.id === 'string') nodes.set(header.id, nodeOf(header, record.live === true))
    }
    for (const session of this.liveSessions()) {
      if (!nodes.has(session.id)) nodes.set(session.id, nodeOf(session.header, true))
    }
    this.nodes = nodes
    this.children = undefined
    this.loadedAt = Date.now()
    return this
  }

  /** 缓存不超过 maxAgeMs 就直接用；并发调用共享同一次读取。 */
  ensure(maxAgeMs = this.ttlMs) {
    if (this.loadedAt > 0 && Date.now() - this.loadedAt <= maxAgeMs) return Promise.resolve(this)
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** 过期时在后台刷新，不等结果（给同步路径用）。 */
  touch() {
    if (this.inflight === undefined && Date.now() - this.loadedAt > this.ttlMs) this.ensure().catch(() => {})
  }

  get ready() {
    return this.loadedAt > 0
  }

  /** 新会话创建时补进索引。 */
  add(header) {
    if (typeof header?.id !== 'string') return
    this.nodes.set(header.id, nodeOf(header, true))
    this.children = undefined
  }

  liveSessions() {
    try {
      return this.ctx.sessions.list()
    } catch {
      return []
    }
  }

  get(id) {
    return this.nodes.get(id)
  }

  /** 用户分叉出来的会话（不含子 agent）。 */
  isBranch(id) {
    const node = this.nodes.get(id)
    return node !== undefined && node.parent !== undefined && !node.subagent
  }

  childMap() {
    if (this.children === undefined) {
      const map = new Map()
      for (const node of this.nodes.values()) {
        if (node.parent === undefined) continue
        const list = map.get(node.parent)
        if (list === undefined) map.set(node.parent, [node])
        else list.push(node)
      }
      for (const list of map.values()) list.sort(byCreation)
      this.children = map
    }
    return this.children
  }

  /** 直接的分支（默认不含子 agent 会话）。 */
  childrenOf(id, { includeSubagents = false } = {}) {
    const list = this.childMap().get(id) ?? []
    return includeSubagents ? list : list.filter((node) => !node.subagent)
  }

  /** 从自己一路到根的节点；父会话已删除时停在最后一个能找到的节点。 */
  pathToRoot(id) {
    const path = []
    const seen = new Set()
    let node = this.nodes.get(id)
    while (node !== undefined && !seen.has(node.id)) {
      path.push(node)
      seen.add(node.id)
      node = node.parent === undefined ? undefined : this.nodes.get(node.parent)
    }
    return path
  }

  rootOf(id) {
    return this.pathToRoot(id).at(-1)
  }

  /**
   * 整棵树按深度优先排好。子 agent 会话不显示，但它下面的分支挂到最近的可见祖先上。
   * 编号按创建时间：根是 #0，其余依次 #1、#2……新分支总是拿到最大的号，已有编号不会变。
   */
  treeOf(id) {
    const root = this.rootOf(id)
    if (root === undefined) return { root: undefined, entries: [], hidden: 0 }
    const entries = []
    let hidden = 0
    const visit = (node, depth, parentEntry) => {
      if (node.subagent && node !== root) {
        hidden += 1
        if (parentEntry !== undefined) parentEntry.subagents += 1
        for (const child of this.childrenOf(node.id, { includeSubagents: true })) visit(child, depth, parentEntry)
        return
      }
      const entry = { node, depth, number: 0, parentId: parentEntry?.node.id, subagents: 0 }
      entries.push(entry)
      for (const child of this.childrenOf(node.id, { includeSubagents: true })) visit(child, depth + 1, entry)
    }
    visit(root, 0, undefined)
    const ordered = entries.filter((entry) => entry.node !== root).sort((a, b) => byCreation(a.node, b.node))
    ordered.forEach((entry, index) => {
      entry.number = index + 1
    })
    return { root, entries, hidden }
  }

  /** 两个会话是否在同一棵树里，以及 source 相对 target 的关系。 */
  relation(sourceId, targetId) {
    const source = this.nodes.get(sourceId)
    const target = this.nodes.get(targetId)
    if (source === undefined || target === undefined) return null
    if (source.parent === targetId) return 'child'
    if (target.parent === sourceId) return 'parent'
    const roots = this.rootOf(sourceId)
    return roots !== undefined && roots === this.rootOf(targetId) ? 'other' : null
  }

  /** 记住已知的切点（读日志时顺手拿到的）。 */
  rememberCut(id, cut) {
    if (Number.isSafeInteger(cut) && cut >= 0) this.cuts.set(id, cut)
  }

  /** 会话从父会话继承了多少个事件。 */
  async cutOf(id) {
    const known = this.cuts.get(id)
    if (known !== undefined) return known
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      this.rememberCut(id, live.inheritedEventCount)
      return live.inheritedEventCount
    }
    const node = this.nodes.get(id)
    const view = node === undefined ? undefined : this.cachedValues(node)?.[PROJECTION_KEY]
    if (Number.isSafeInteger(view?.cut) && (view.cut > 0 || node.parent === undefined)) {
      this.rememberCut(id, view.cut)
      return view.cut
    }
    const read = await this.ctx.sessionQuery.readSession(id)
    this.rememberCut(id, read.inheritedEventCount)
    return read.inheritedEventCount
  }

  /**
   * 两个会话共享的事件前缀长度：最近公共祖先下方两条路径上所有切点的最小值。
   * 同一个会话返回 Infinity；不在同一棵树里返回 null。
   */
  async commonPrefix(a, b) {
    if (a === b) return { lca: a, prefix: Infinity }
    const pathA = this.pathToRoot(a)
    const pathB = this.pathToRoot(b)
    const indexB = new Map(pathB.map((node, index) => [node.id, index]))
    const lcaIndexA = pathA.findIndex((node) => indexB.has(node.id))
    if (lcaIndexA < 0) return null
    const lca = pathA[lcaIndexA]
    const below = [...pathA.slice(0, lcaIndexA), ...pathB.slice(0, indexB.get(lca.id))]
    let prefix = Infinity
    for (const node of below) prefix = Math.min(prefix, await this.cutOf(node.id))
    return { lca: lca.id, prefix }
  }

  cachedValues(node) {
    try {
      return this.ctx.get('sessionProjectionCache')?.cachedSnapshot(node.header, SNAPSHOT_KEYS)?.values
    } catch {
      return undefined
    }
  }

  /** 同步读标题和 sessionGit 视图：存活会话读注册表，冷会话读缓存。拿不到就是 undefined。 */
  snapshotOf(id) {
    const node = this.nodes.get(id)
    const live = this.ctx.sessions.get(id)
    let values
    if (live !== undefined) {
      try {
        values = this.ctx.sessionProjections.snapshot(live, SNAPSHOT_KEYS)?.values
      } catch {
        values = undefined
      }
    } else if (node !== undefined) {
      values = this.cachedValues(node)
    }
    const title = values?.title
    return {
      id,
      live: live !== undefined,
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined,
      view: values?.[PROJECTION_KEY] ?? undefined
    }
  }

  /** 和 snapshotOf 一样，但缺视图时读一次日志补上（冷会话、装插件之前就关掉的会话）。 */
  async exactSnapshotOf(id) {
    const snapshot = this.snapshotOf(id)
    if (snapshot.view !== undefined && snapshot.title !== undefined) return snapshot
    try {
      const read = await this.ctx.sessionQuery.readSession(id)
      this.rememberCut(id, read.inheritedEventCount)
      const view = snapshot.view ?? viewOf(foldEvents(read.events, read.inheritedEventCount, read.session))
      let title = snapshot.title
      if (title === undefined) {
        for (const event of read.events) {
          if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') title = event.data.title.trim()
        }
      }
      return { ...snapshot, view, title }
    } catch {
      return snapshot
    }
  }

  /** 展示用的标题：有标题用标题，否则用短 id。 */
  label(id, untitled) {
    return this.snapshotOf(id).title ?? `${untitled ?? ''}${untitled ? ' ' : ''}${shortId(id)}`.trim()
  }

  /**
   * 按用户输入找会话：#编号、完整 id、id 前缀（≥4 位，可带 session-）、标题全匹配、标题包含。
   * 先在调用者所在的树里找，找不到再看全部会话（用来提示「不在同一棵树里」）。
   * @returns {{ match?: object, candidates: object[], outside?: object }}
   */
  resolve(query, callerId) {
    const text = String(query ?? '').trim()
    const tree = this.treeOf(callerId)
    const members = tree.entries.filter((entry) => entry.node.id !== callerId)
    if (text === '') return { candidates: members }

    const numbered = /^#(\d+)$/u.exec(text)
    if (numbered !== null) {
      const number = Number(numbered[1])
      const match = number === 0 ? tree.entries.find((entry) => entry.node === tree.root) : tree.entries.find((entry) => entry.number === number && entry.node !== tree.root)
      return match !== undefined && match.node.id !== callerId ? { match, candidates: [match] } : { candidates: [] }
    }

    const bare = bareId(text)
    const exact = members.find((entry) => entry.node.id === text || bareId(entry.node.id) === bare)
    if (exact !== undefined) return { match: exact, candidates: [exact] }
    if (bare.length >= ID_PREFIX_MIN && /^[0-9a-z-]+$/u.test(bare)) {
      const prefixed = members.filter((entry) => bareId(entry.node.id).startsWith(bare))
      if (prefixed.length === 1) return { match: prefixed[0], candidates: prefixed }
      if (prefixed.length > 1) return { candidates: prefixed }
    }

    const lower = text.toLowerCase()
    const titled = members.map((entry) => ({ entry, title: (this.snapshotOf(entry.node.id).title ?? '').toLowerCase() }))
    const same = titled.filter((item) => item.title !== '' && item.title === lower).map((item) => item.entry)
    if (same.length === 1) return { match: same[0], candidates: same }
    const containing = same.length > 1 ? same : titled.filter((item) => item.title.includes(lower)).map((item) => item.entry)
    if (containing.length === 1) return { match: containing[0], candidates: containing }
    if (containing.length > 1) return { candidates: containing }

    // 树外的会话：只用来给出准确的报错
    for (const node of this.nodes.values()) {
      if (node.id === callerId) continue
      if (node.id === text || bareId(node.id) === bare || (bare.length >= ID_PREFIX_MIN && bareId(node.id).startsWith(bare))) return { candidates: [], outside: node }
    }
    return { candidates: [] }
  }
}
