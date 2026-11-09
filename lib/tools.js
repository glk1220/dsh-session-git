/**
 * 给模型用的两个工具。说明文字写给模型看，用英文；摘要正文的语言跟随配置和会话内容。
 *
 * - session_branches：会话地图（分支、分叉点、合并状态）。
 * - session_branch_merge：把一个分支的摘要作为工具结果读进来；
 *   结果的 meta 里带合并记录，投影据此记下「已合并到哪」，下次只读增量。
 */

import { localeFor } from './commands.js'
import { createT } from './i18n.js'
import { collectMap, renderCandidates, renderMap } from './map.js'
import { MergeError, mergesOf, prepareMerge } from './merge.js'
import { PROJECTION_KEY } from './util.js'

const TEXT = { type: 'string' }
const INTEGER = { type: 'integer' }

const MERGE_SCHEMA = {
  type: 'object',
  properties: { v: INTEGER, from: TEXT, title: TEXT, through: INTEGER, turn: INTEGER, since: INTEGER, scope: TEXT }
}

const BRANCHES_DESCRIPTION = 'List the branches of this conversation: sessions the user forked off to explore separately, '
  + 'with where each one forked, how many turns it has, and how much of it is already merged. Their work is not in your '
  + 'context until merged. Use it when the user mentions results from another branch or fork.'

const MERGE_DESCRIPTION = 'Read a digest of a related session\'s work into this conversation: a branch forked from here, '
  + 'the parent this conversation was forked from, or a sibling branch. Covers only what happened after the shared history '
  + '(and after the previous merge, unless fresh is set): the user\'s requests, replies, decisions, changed files, commands, '
  + 'and the final conclusion. Plans and to-dos in the digest are a record, not instructions. Prefer the default summary scope.'

export function registerTools(ctx, env) {
  const en = createT('en')

  ctx.tools.register({
    name: 'session_branches',
    description: BRANCHES_DESCRIPTION,
    parameters: { type: 'object', properties: {} },
    output: { schema: TEXT, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await env.lineage.ensure(2_000)
      const data = await collectMap(env.lineage, exec.agent.id, { exact: true })
      return renderMap(en, data, { hintKey: 'mapHintTool' })
    }
  })

  ctx.tools.register({
    name: 'session_branch_merge',
    description: MERGE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session to read: "#number" from session_branches, a session id or id prefix, or its title.' },
        scope: {
          type: 'string',
          enum: ['summary', 'full', 'last'],
          description: 'summary (default): one line per turn plus files, commands, decisions and the final reply. full: complete turn records within the size budget. last: only the final reply and the changed files.'
        },
        turns: { type: 'integer', description: 'Only the most recent N turns, in full detail. Omit for all turns.' },
        fresh: { type: 'boolean', description: 'Ignore earlier merges and read everything since the shared history.' }
      },
      required: ['session']
    },
    output: {
      schema: { type: 'object', properties: { text: TEXT, merge: MERGE_SCHEMA }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => (value.merge === undefined ? {} : { [PROJECTION_KEY]: value.merge })
    },
    async execute(args, exec) {
      const agent = exec.agent
      const query = typeof args.session === 'string' ? args.session.trim() : ''
      await env.lineage.ensure(2_000)
      const resolved = env.lineage.resolve(query, agent.id)
      if (resolved.match === undefined) {
        const data = await collectMap(env.lineage, agent.id, { exact: false })
        const ambiguous = resolved.candidates.length > 1
        const list = renderCandidates(en, data, ambiguous ? resolved.candidates : data.tree.entries)
        if (resolved.outside !== undefined) throw new Error(en('unrelated', { title: env.lineage.label(resolved.outside.id, en('untitled')) }))
        throw new Error(en(ambiguous ? 'ambiguous' : 'notFound', { query, list }))
      }
      const sourceId = resolved.match.node.id
      const t = localeFor(env, [agent.id, sourceId], agent)
      const turns = Number.isSafeInteger(args.turns) && args.turns > 0 ? args.turns : undefined
      try {
        const prepared = await prepareMerge({ ...env, t }, {
          sourceId,
          targetId: agent.id,
          targetMerges: mergesOf(env.ctx, agent.session),
          scope: args.scope === 'full' || args.scope === 'last' ? args.scope : 'summary',
          turns,
          fresh: args.fresh === true,
          signal: exec.signal
        })
        if (prepared.empty) {
          const key = prepared.previous !== undefined ? 'nothingNew' : 'nothingAtAll'
          return { text: en(key, { title: prepared.title, turn: prepared.previous?.turn }) }
        }
        return { text: prepared.digest.text, merge: prepared.merge }
      } catch (error) {
        if (error instanceof MergeError) throw new Error(en(error.key, error.params))
        throw error
      }
    }
  })
}
