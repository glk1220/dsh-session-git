/**
 * 文本版会话地图：/branches 命令、session_branches 工具和合并命令的候选列表共用。
 */

import { mapLimited, shortId } from './util.js'

/** 冷会话没有缓存时最多补读几份日志（每份都要读整个日志）。 */
const EXACT_READ_LIMIT = 12

/**
 * 收集整棵树的标题和 sessionGit 视图。
 * @param {object} lineage LineageIndex
 * @param {string} callerId 当前会话
 * @param {{ exact?: boolean }} options exact 为 true 时，缺视图的冷会话会读日志补上
 */
export async function collectMap(lineage, callerId, { exact = true } = {}) {
  await lineage.ensure()
  const tree = lineage.treeOf(callerId)
  const snapshots = new Map(tree.entries.map((entry) => [entry.node.id, lineage.snapshotOf(entry.node.id)]))
  if (exact) {
    const missing = tree.entries.filter((entry) => {
      const snapshot = snapshots.get(entry.node.id)
      return snapshot.view === undefined || snapshot.title === undefined
    }).slice(0, EXACT_READ_LIMIT)
    const filled = await mapLimited(missing, 4, (entry) => lineage.exactSnapshotOf(entry.node.id))
    for (const snapshot of filled) snapshots.set(snapshot.id, snapshot)
  }
  return { tree, snapshots, callerId }
}

/** 一个分支相对父会话的合并状态。 */
export function branchStatus(entry, snapshots) {
  const snapshot = snapshots.get(entry.node.id)
  const view = snapshot?.view
  if (view === undefined) return { known: false, running: false }
  const ownTurns = Math.max(0, view.doneTurn - view.forkTurn)
  const parentView = entry.parentId === undefined ? undefined : snapshots.get(entry.parentId)?.view
  const merged = parentView?.merges?.[entry.node.id]
  const unmerged = merged === undefined ? ownTurns : Math.max(0, view.doneTurn - Math.max(merged.turn, view.forkTurn))
  return {
    known: true,
    forkTurn: view.forkTurn,
    turns: view.doneTurn,
    ownTurns,
    merged,
    unmerged,
    running: snapshot.live && view.turn > view.doneTurn
  }
}

function lineFor(t, entry, data, isRoot) {
  const { snapshots, callerId } = data
  const snapshot = snapshots.get(entry.node.id)
  const title = snapshot?.title ?? t('untitled')
  const status = branchStatus(entry, snapshots)
  const parts = [`#${isRoot ? 0 : entry.number} ${title}${t('paren', { text: shortId(entry.node.id) })}`]
  if (isRoot) {
    if (status.known) parts.push(t('mapTurns', { count: status.turns }))
  } else if (status.known) {
    parts.push(t('mapForked', { turn: status.forkTurn }))
    parts.push(t('mapOwnTurns', { count: status.ownTurns }))
    if (status.merged !== undefined && status.merged.pending) parts.push(t('mapPending'))
    else if (status.merged !== undefined && status.unmerged === 0) parts.push(t('mapMerged'))
    else if (status.merged !== undefined) parts.push(t('mapPartly', { count: status.unmerged }))
    else if (status.ownTurns > 0) parts.push(t('mapUnmerged'))
  }
  if (status.running) parts.push(t('mapRunning'))
  if (entry.subagents > 0) parts.push(t('mapSubagents', { count: entry.subagents }))
  if (entry.node.id === callerId) parts.push(`← ${t('mapCurrent')}`)
  return parts.join(' · ')
}

/** 画成带连线的树。 */
export function renderTree(t, data) {
  const { tree } = data
  if (tree.root === undefined) return ''
  const children = new Map()
  for (const entry of tree.entries) {
    if (entry.node === tree.root) continue
    const list = children.get(entry.parentId) ?? []
    list.push(entry)
    children.set(entry.parentId, list)
  }
  const lines = []
  const visit = (entry, prefix, last, isRoot) => {
    const branch = isRoot ? '' : last ? '└─ ' : '├─ '
    lines.push(`${prefix}${branch}${lineFor(t, entry, data, isRoot)}`)
    const next = isRoot ? '' : `${prefix}${last ? '   ' : '│  '}`
    const list = children.get(entry.node.id) ?? []
    list.forEach((child, index) => visit(child, next, index === list.length - 1, false))
  }
  visit(tree.entries.find((entry) => entry.node === tree.root), '', true, true)
  return lines.join('\n')
}

/** /branches 的完整输出：标题行、树、操作提示。 */
export function renderMap(t, data, { hintKey } = {}) {
  const { tree, callerId } = data
  if (tree.entries.length <= 1) return t('mapAlone')
  const lines = [t('mapTitle', { count: tree.entries.length }), renderTree(t, data)]
  if (tree.hidden > 0) lines.push(t('mapHiddenTotal', { count: tree.hidden }))
  const self = tree.entries.find((entry) => entry.node.id === callerId)
  const hasChildren = tree.entries.some((entry) => entry.parentId === callerId)
  if (hintKey !== undefined) lines.push('', t(hintKey))
  else if (hasChildren) lines.push('', t('mapHintChild'))
  else if (self !== undefined && self.parentId !== undefined) lines.push('', t('mapHintBranch'))
  return lines.join('\n')
}

/** 合并命令出错时附带的候选清单（不含当前会话）。 */
export function renderCandidates(t, data, entries) {
  const lines = entries.filter((entry) => entry.node.id !== data.callerId).map((entry) => `- ${lineFor(t, entry, data, entry.node === data.tree.root)}`)
  return lines.length > 0 ? lines.join('\n') : t('noCandidates')
}
