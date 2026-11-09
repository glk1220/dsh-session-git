/**
 * 会话 Git 的通用小工具：文本处理、id 展示、冻结消息。
 * 不依赖任何 DSH 包，Host 各模块共用。
 */

import { randomUUID } from 'node:crypto'

/** 合并消息的 source.kind；投影、聊天卡片和客户端都靠它识别合并记录。 */
export const SOURCE_KIND = 'session-git'

/** 会话投影的键（客户端从 projectionValues 里按这个键读）。 */
export const PROJECTION_KEY = 'sessionGit'

/** 合并元数据的格式版本，写在 source.merge.v 里。 */
export const MERGE_FORMAT = 1

const SESSION_PREFIX = /^session-/u
const CJK = /[㐀-鿿豈-﫿]/u

/** 会话 id 的短形式：去掉 session- 前缀后取 8 位。 */
export function shortId(id) {
  return String(id ?? '').replace(SESSION_PREFIX, '').slice(0, 8)
}

/** 取消息 content 里的纯文本（忽略 reasoning、图片、工具块）。 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 去掉 Harness 拼进来的提醒块和标签，只留人写的话。 */
export function humanize(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, ' ')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, ' ')
    .replace(/<session-git-merge[\s\S]*?<\/session-git-merge>/gu, ' ')
    .trim()
}

/** 压成一行并按字符数截断。 */
export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** 保留开头若干字符；超出时在末尾注明省略了多少。 */
export function clip(text, max, omittedLabel) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  const omitted = value.length - max
  const note = typeof omittedLabel === 'function' ? omittedLabel(omitted) : `…(+${omitted})`
  return `${value.slice(0, max).trimEnd()}\n${note}`
}

/** 文本里是否有中日韩字符。 */
export function hasCjk(text) {
  return CJK.test(String(text ?? ''))
}

/** 递归冻结，和 DSH 自己创建消息时的做法一致。 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** 造一条带新 id、已冻结的 user 角色消息。 */
export function createUserMessage(content, source) {
  return deepFreeze(structuredClone({ role: 'user', content, source, id: randomUUID() }))
}

/** 并发受限的 map，保持输入顺序。 */
export async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 把毫秒时间渲染成 MM-DD HH:mm（本地时区）。 */
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
