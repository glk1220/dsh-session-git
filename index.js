/**
 * 会话 Git（dsh-session-git）—— Host 半边。
 *
 * fork 出来的分支会话各走各的，主会话看不到分支里做了什么。这个插件：
 *   - 用 sessionGit 投影记下每个会话的分叉点、轮次进度和合并记录（客户端地图也读它）；
 *   - /merge 把分支在分叉之后（或上次合并之后）的工作整理成摘要，静默并入当前会话；
 *     在分支里直接 /merge，就是把本分支合并回父会话；
 *   - /branches 打印会话地图；
 *   - 给模型 session_branches / session_branch_merge 两个工具，并在运行时上下文里
 *     告诉它这段对话有哪些分支。
 * 不依赖任何 DSH 包，只通过 ctx 上的服务工作。
 */

import { registerCommands } from './lib/commands.js'
import { registerContext } from './lib/context.js'
import { DEFAULT_MAX_CHARS } from './lib/digest.js'
import { LineageIndex } from './lib/lineage.js'
import { projectionDefinition } from './lib/projection.js'
import { registerTools } from './lib/tools.js'

export const name = 'session-git'

export const inject = ['sessionQuery', 'sessionProjections', 'sessions']

const DEFAULTS = Object.freeze({
  runtimeContext: true,
  tools: true,
  maxDigestChars: DEFAULT_MAX_CHARS,
  maxContextBranches: 8,
  locale: 'auto'
})

/** 补齐默认值并拒绝明显不合理的取值（没有 schemastery 可用，手写校验）。 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  if (typeof source.runtimeContext === 'boolean') config.runtimeContext = source.runtimeContext
  if (typeof source.tools === 'boolean') config.tools = source.tools
  if (Number.isSafeInteger(source.maxDigestChars)) config.maxDigestChars = Math.min(200_000, Math.max(2_000, source.maxDigestChars))
  if (Number.isSafeInteger(source.maxContextBranches)) config.maxContextBranches = Math.min(50, Math.max(1, source.maxContextBranches))
  if (source.locale === 'zh' || source.locale === 'en' || source.locale === 'auto') config.locale = source.locale
  return config
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  ctx.sessionProjections.register(projectionDefinition)

  const lineage = new LineageIndex(ctx)
  const env = { ctx, lineage, config }
  ctx.on('session/created', (session) => {
    lineage.add(session.header)
  }, { global: true })
  lineage.ensure().catch((error) => {
    ctx.logger?.warn?.(`session-git: listing sessions failed: ${String(error)}`)
  })

  ctx.inject(['commands'], function sessionGitCommands(ctx) {
    registerCommands(ctx, env)
  })
  if (config.tools) {
    ctx.inject(['tools'], function sessionGitTools(ctx) {
      registerTools(ctx, env)
    })
  }
  if (config.runtimeContext) {
    ctx.inject(['systemPrompt'], function sessionGitContext(ctx) {
      registerContext(ctx, env)
    })
  }
}
