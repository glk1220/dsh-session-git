/**
 * 运行时上下文：让模型知道这段对话有哪些分支、自己是不是从别处分出来的。
 *
 * 只放很少变化的信息（分支列表、分叉点）。运行时上下文的文本一变，Harness 就会追加一份
 * 新的快照消息，所以合并状态、「分支又多了几轮」这类会变的东西都不放进来：合并进来的内容
 * 本身就在对话里，其余的模型需要时调用 session_branches 查。
 */

import { PROJECTION_KEY, oneLine, shortId } from './util.js'

export const CONTEXT_NAME = 'session-git:lineage'
export const CONTEXT_ORDER = 230

function ownView(ctx, session) {
  try {
    return ctx.sessionProjections.snapshot(session, [PROJECTION_KEY])?.values?.[PROJECTION_KEY] ?? undefined
  } catch {
    return undefined
  }
}

function quoted(title) {
  return title === undefined ? 'an untitled session' : `"${oneLine(title, 60)}"`
}

/** 为某个 agent 生成上下文文本；没有血缘关系时返回空串。 */
export function lineageContextText(env, agent) {
  const { lineage, config } = env
  lineage.touch()
  if (!lineage.ready || agent === undefined) return ''
  const node = lineage.get(agent.id)
  if (node === undefined || node.subagent) return ''
  const children = lineage.childrenOf(agent.id)
  if (node.parent === undefined && children.length === 0) return ''

  const own = ownView(env.ctx, agent.session)
  const lines = []
  if (node.parent !== undefined) {
    const parent = lineage.snapshotOf(node.parent)
    const after = Number.isSafeInteger(own?.forkTurn) ? ` after turn ${own.forkTurn}` : ''
    lines.push(`This conversation is a branch the user forked from ${quoted(parent.title)} (${shortId(node.parent)})${after}. `
      + 'Work done here stays in this branch until the user merges it back with /merge.')
  }
  if (children.length > 0) {
    const numbers = new Map(lineage.treeOf(agent.id).entries.map((entry) => [entry.node.id, entry.number]))
    const shown = children.slice(-config.maxContextBranches)
    lines.push(`The user forked ${children.length === 1 ? 'a branch' : `${children.length} branches`} off this conversation to explore separately. `
      + 'Their work reaches you only when the user merges it, as a <session-git-merge> message:')
    for (const child of shown) {
      const snapshot = lineage.snapshotOf(child.id)
      const forked = Number.isSafeInteger(snapshot.view?.forkTurn) ? `; forked after turn ${snapshot.view.forkTurn}` : ''
      lines.push(`- #${numbers.get(child.id) ?? '?'} ${quoted(snapshot.title)} (${shortId(child.id)}${forked})`)
    }
    if (children.length > shown.length) lines.push(`- … and ${children.length - shown.length} older branches`)
    lines.push(config.tools
      ? 'When the user refers to results from a branch, call session_branches for its current state and session_branch_merge to read its digest.'
      : 'The user can bring a branch\'s work in with /merge.')
  }
  return `Session Git:\n${lines.join('\n')}`
}

/**
 * 注册运行时上下文。context 的 text 是同步的，第一次组装时血缘索引可能还没加载完，
 * 所以在 assemble 钩子里等索引就绪后重算一遍，和 working-directory 插件的做法一样。
 */
export function registerContext(ctx, env) {
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => lineageContextText(env, context.agent)
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context?.agent === undefined) return next()
    await env.lineage.ensure().catch(() => undefined)
    const assembly = await next()
    const text = lineageContextText(env, context.agent)
    const contribution = assembly.contexts.find((entry) => entry.name === CONTEXT_NAME)
    if (contribution !== undefined) contribution.text = text
    else if (text !== '') assembly.contexts.push({ name: CONTEXT_NAME, text, interpolate: false })
    return assembly
  }, { prepend: true })
}
