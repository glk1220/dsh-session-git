/**
 * 把一个会话在某个切点之后的事件整理成「合并摘要」。
 *
 * 输入是 sessionQuery 读出的原始事件（tool/call、todo/write、compaction/summary……），
 * 输出一段给模型看的结构化文本，以及给卡片标题、命令结果用的统计。
 * 纯函数，不做 I/O；工作区改动统计由调用方以回调提供（只有会话存活时才有）。
 */

import { homedir } from 'node:os'
import { PROJECTION_KEY, SOURCE_KIND, clip, humanize, oneLine, shortId, textOf } from './util.js'

/** 改文件的工具。str_replace_editor 的 view 是只读的，单独排除。 */
const FILE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace_editor', 'notebook_edit', 'apply_patch'])
/** 执行命令的工具及命令所在的参数。 */
const SHELL_TOOLS = new Map([['bash', 'command'], ['pwsh', 'command'], ['terminal_send', 'text']])
const DELEGATE_TOOLS = new Set(['subagent'])
const QUESTION_TOOLS = new Set(['ask_user_question'])
const REPORT_SOURCES = new Set(['agent-message', 'subagent-settled'])
const REPORT_BOILERPLATE = [
  /^Agent \S+ sent a message:\s*/u,
  /^Background subagent \S+ finished[\s\S]*?Its closing message:\s*/u,
  /^Report delivered to the parent agent\. Here is the full result\.\s*/u
]

/** 默认字符上限。 */
export const DEFAULT_MAX_CHARS = 24000

function parseArgs(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** 工具参数里被改动的路径；只读操作返回 []。 */
function editedPaths(name, args) {
  if (name === 'str_replace_editor' && args.command === 'view') return []
  if (name === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : typeof args.input === 'string' ? args.input : ''
    return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)].map((match) => match[1].trim())
  }
  const path = args.file_path ?? args.path ?? args.notebook_path
  return typeof path === 'string' && path !== '' ? [path] : []
}

/** 绝对路径在工作目录里就转成相对路径，在家目录里就写成 ~/…，和工作区改动卡片的写法一致。 */
export function displayPath(path, cwd, home) {
  for (const sep of ['/', '\\']) {
    if (typeof cwd === 'string' && cwd !== '' && path.startsWith(cwd + sep)) return path.slice(cwd.length + 1)
  }
  for (const sep of ['/', '\\']) {
    if (typeof home === 'string' && home !== '' && path.startsWith(home + sep)) return `~/${path.slice(home.length + 1)}`
  }
  return path
}

function resultFailed(data) {
  const message = data?.message
  if (message?.isError === true || data?.error !== undefined) return true
  const head = textOf(message?.content).slice(0, 400)
  return /\bexit(?:ed with)? code:? *[1-9]\d*/iu.test(head)
}

function stripReport(text) {
  let value = text
  for (const pattern of REPORT_BOILERPLATE) value = value.replace(pattern, '')
  return value.trim()
}

/** ask_user_question 的问题和回答，配成「问题 → 回答」。 */
function decisionsOf(questions, resultText) {
  let answers
  try {
    answers = JSON.parse(resultText)?.answers
  } catch {
    return []
  }
  if (!Array.isArray(answers)) return []
  const byId = new Map((Array.isArray(questions) ? questions : []).map((question) => [question?.id, question]))
  return answers.map((answer) => {
    const question = byId.get(answer?.id)
    const label = question?.header ?? question?.question ?? answer?.id ?? ''
    const picked = Array.isArray(answer?.selected) ? answer.selected.filter((item) => typeof item === 'string') : []
    if (typeof answer?.custom === 'string' && answer.custom.trim() !== '') picked.push(answer.custom.trim())
    return { question: String(label), answer: picked.join(' / ') }
  })
}

function newTurn(turn, seq, partial) {
  return { turn, startSeq: seq, ended: null, partial, prompts: [], replies: [], reports: new Map(), delegations: [], merges: [], decisions: [], tools: new Map(), commands: [] }
}

/**
 * 把事件解析成轮次和汇总材料。
 * @param {object[]} events 原始事件，按 seq 升序
 * @param {number} start 只看 seq >= start 的事件
 */
export function collect(events, start, options = {}) {
  const { titleOf = (id) => shortId(id), workspaceChanges, cwd, home = safe(homedir) } = options
  const turns = []
  const files = new Map()
  const calls = new Map()
  const goals = []
  let todos = null
  let compaction = null
  let current = null
  let loose = []
  let lastSeq = -1
  let doneTurn = 0

  const open = (turn, seq, partial) => {
    current = newTurn(turn, seq, partial)
    turns.push(current)
    if (loose.length > 0) {
      current.prompts.push(...loose)
      loose = []
    }
    return current
  }
  /** 范围从一轮中间开始时，按事件上的 turn 号补开一轮。 */
  const turnFor = (event) => {
    const turn = event.data?.turn
    if (current !== null && (!Number.isSafeInteger(turn) || current.turn === turn)) return current
    return Number.isSafeInteger(turn) ? open(turn, event.seq, true) : current
  }
  const touchFile = (rawPath, op, counts) => {
    const path = displayPath(rawPath, cwd, home)
    let entry = files.get(path)
    if (entry === undefined) {
      entry = { path, ops: new Map(), added: 0, deleted: 0, counted: false }
      files.set(path, entry)
    }
    if (op !== undefined) entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1)
    if (counts !== undefined) {
      entry.added += counts.added
      entry.deleted += counts.deleted
      entry.counted = true
    }
  }

  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) lastSeq = Math.max(lastSeq, event.seq)
    if (!(event?.seq >= start)) continue
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        if (Number.isSafeInteger(data?.turn)) open(data.turn, event.seq, false)
        break
      case 'turn/end': {
        const turn = turnFor(event)
        if (turn !== null) turn.ended = data?.reason?.kind ?? 'completed'
        if (Number.isSafeInteger(data?.turn)) doneTurn = Math.max(doneTurn, data.turn)
        current = null
        break
      }
      case 'user/message': {
        const source = data?.source
        const kind = source?.kind
        if (kind === 'user') {
          const text = humanize(textOf(data?.content))
          if (text !== '') (current === null ? loose : current.prompts).push(text)
        } else if (REPORT_SOURCES.has(kind) && current !== null) {
          const text = stripReport(textOf(data?.content))
          if (text !== '') current.reports.set(source.senderSessionId ?? `#${current.reports.size}`, text)
        } else if (kind === SOURCE_KIND && current !== null) {
          const from = source?.merge?.from
          if (typeof from === 'string') current.merges.push(titleOf(from))
        }
        break
      }
      case 'assistant/message': {
        const turn = turnFor(event)
        const text = textOf(data?.message?.content)
        if (turn !== null && text !== '') turn.replies.push(text)
        break
      }
      case 'tool/call': {
        const turn = turnFor(event)
        const name = typeof data?.name === 'string' ? data.name : 'tool'
        const args = parseArgs(data?.arguments)
        const call = { name, args, failed: false }
        if (typeof data?.callId === 'string') calls.set(data.callId, call)
        if (turn !== null) turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1)
        if (FILE_TOOLS.has(name)) {
          const op = name === 'str_replace_editor' && typeof args.command === 'string' ? args.command : name
          for (const path of editedPaths(name, args)) touchFile(path, op)
        } else if (SHELL_TOOLS.has(name) && turn !== null) {
          const command = args[SHELL_TOOLS.get(name)]
          if (typeof command === 'string' && command.trim() !== '') {
            turn.commands.push({ command, description: typeof args.description === 'string' ? args.description : '', call })
          }
        } else if (DELEGATE_TOOLS.has(name) && turn !== null) {
          const task = args.description ?? args.prompt
          if (typeof task === 'string' && task !== '') turn.delegations.push(task)
        }
        break
      }
      case 'tool/result': {
        const merged = data?.meta?.[PROJECTION_KEY]?.from
        if (typeof merged === 'string') turnFor(event)?.merges.push(titleOf(merged))
        const callId = data?.message?.toolCallId ?? data?.message?.source?.callId
        const call = typeof callId === 'string' ? calls.get(callId) : undefined
        if (call === undefined) break
        if (resultFailed(data)) call.failed = true
        else if (QUESTION_TOOLS.has(call.name)) {
          const turn = turnFor(event)
          if (turn !== null) turn.decisions.push(...decisionsOf(call.args.questions, textOf(data.message.content)))
        }
        break
      }
      case 'todo/write':
        if (Array.isArray(data?.todos)) todos = data.todos
        break
      case 'goal/change': {
        const objective = data?.goal?.objective
        if (typeof objective === 'string' && objective.trim() !== '' && goals.at(-1) !== objective) goals.push(objective)
        break
      }
      case 'compaction/summary': {
        // 只压缩了共享历史的摘要，目标会话自己就有，不重复带过去
        const end = data?.shadowedRange?.end
        const text = textOf(data?.summary)
        if (text !== '' && !(Number.isSafeInteger(end) && end < start)) compaction = text
        break
      }
      case 'workspace/changes': {
        const summary = typeof workspaceChanges === 'function' ? safe(() => workspaceChanges(event.seq)) : undefined
        if (Array.isArray(summary?.files)) {
          for (const file of summary.files) {
            const path = typeof file?.display === 'string' ? file.display : file?.path
            if (typeof path === 'string') touchFile(path, undefined, { added: Number(file.added) || 0, deleted: Number(file.deleted) || 0 })
          }
        }
        break
      }
      default:
        break
    }
  }

  const last = turns.at(-1)
  const running = last !== undefined && last.ended === null ? last.turn : null
  // fork 时补的收尾事件会留下空轮次，去掉
  const meaningful = turns.filter((turn) => turn.prompts.length + turn.replies.length + turn.tools.size + turn.reports.size + turn.merges.length > 0)
  if (loose.length > 0) meaningful.push({ ...newTurn(null, lastSeq, true), prompts: loose })
  return { turns: meaningful, files, goals, todos, compaction, lastSeq, doneTurn, running }
}

function toolSummary(tools) {
  return [...tools.entries()].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(', ')
}

function turnHeading(t, turn) {
  // partial：范围从这一轮中间开始（上次合并时它还在运行，或分叉发生在轮次中途）
  const label = turn.turn === null ? '…' : `${t('turnLine', { turn: turn.turn })}${turn.partial ? t('continued') : ''}`
  if (turn.ended === null || turn.ended === 'completed') return label
  const ended = t(`turnEnded.${turn.ended}`)
  return ended.startsWith('turnEnded.') ? label : `${label}${t('paren', { text: ended })}`
}

/** 一轮压成一行。 */
function turnOneLiner(t, turn, level) {
  const parts = [turnHeading(t, turn)]
  const prompt = turn.prompts.join(' / ')
  if (prompt !== '') parts.push(`${t('userLabel')}${t('colon')}${oneLine(prompt, level.prompt)}`)
  const reply = turn.replies.at(-1)
  if (reply !== undefined) parts.push(`${t('assistantLabel')}${t('colon')}${oneLine(reply, level.reply)}`)
  for (const title of turn.merges) parts.push(t('mergedFrom', { title }))
  if (turn.reports.size > 0) parts.push(`${t('subagentReport')}×${turn.reports.size}`)
  if (turn.tools.size > 0) parts.push(`${t('toolsLabel')}${t('colon')}${toolSummary(turn.tools)}`)
  return `- ${parts.join(' · ')}`
}

/** 一轮的完整记录。 */
function turnDetail(t, turn, level, omitted) {
  const lines = [`### ${turnHeading(t, turn)}`]
  for (const prompt of turn.prompts) lines.push(`**${t('userLabel')}**${t('colon')}${clip(prompt, level.prompt, omitted)}`)
  for (const title of turn.merges) lines.push(`*${t('mergedFrom', { title })}*`)
  for (const task of turn.delegations) lines.push(`*subagent*${t('colon')}${oneLine(task, 200)}`)
  for (const report of turn.reports.values()) lines.push(`*${t('subagentReport')}*${t('colon')}${clip(report, level.report, omitted)}`)
  for (const reply of turn.replies.slice(-level.replies)) lines.push(`**${t('assistantLabel')}**${t('colon')}${clip(reply, level.reply, omitted)}`)
  if (turn.replies.length === 0) lines.push(`**${t('assistantLabel')}**${t('colon')}${t('noReply')}`)
  if (turn.tools.size > 0) lines.push(`${t('toolsLabel')}${t('colon')}${toolSummary(turn.tools)}`)
  for (const command of turn.commands.slice(-level.turnCommands)) {
    lines.push(`- \`${oneLine(command.command, 160)}\`${command.call.failed ? t('paren', { text: t('failed') }) : ''}`)
  }
  return lines.join('\n')
}

function moreLine(t, total, shown) {
  return total > shown ? [t('moreItems', { count: total - shown })] : []
}

function fileLines(t, files, limit) {
  const entries = [...files.values()]
  const lines = entries.slice(0, limit).map((entry) => {
    const notes = [...entry.ops.entries()].map(([op, count]) => (count > 1 ? `${op}×${count}` : op))
    if (entry.counted) notes.push(`+${entry.added} −${entry.deleted}`)
    return `- ${entry.path}${notes.length > 0 ? t('paren', { text: notes.join(t('comma')) }) : ''}`
  })
  return [...lines, ...moreLine(t, entries.length, Math.min(limit, entries.length))]
}

/** 命令列表：失败的优先保留，其余取最近的，按原顺序输出。 */
function commandLines(t, turns, limit) {
  if (limit <= 0) return []
  const all = turns.flatMap((turn) => turn.commands)
  const chosen = new Set(all.filter((entry) => entry.call.failed).slice(-Math.ceil(limit / 2)))
  for (let index = all.length - 1; index >= 0 && chosen.size < limit; index -= 1) chosen.add(all[index])
  const lines = all.filter((entry) => chosen.has(entry)).map((entry) => {
    const description = entry.description !== '' ? ` — ${oneLine(entry.description, 80)}` : ''
    return `- \`${oneLine(entry.command, 180)}\`${entry.call.failed ? t('paren', { text: t('failed') }) : ''}${description}`
  })
  return [...lines, ...moreLine(t, all.length, chosen.size)]
}

function todoLines(t, todos, limit) {
  if (!Array.isArray(todos) || todos.length === 0 || limit <= 0) return []
  const lines = todos.slice(0, limit).map((todo) => {
    const mark = todo?.status === 'completed' ? 'x' : todo?.status === 'in_progress' ? '~' : ' '
    return `- [${mark}] ${oneLine(todo?.content ?? '', 200)}`
  })
  return [...lines, ...moreLine(t, todos.length, Math.min(limit, todos.length))]
}

function decisionLines(t, turns, limit) {
  const all = turns.flatMap((turn) => turn.decisions)
  const lines = all.slice(-limit).map((item) => `- ${oneLine(item.question, 80)} → ${item.answer === '' ? t('decisionSkipped') : oneLine(item.answer, 300)}`)
  return [...moreLine(t, all.length, lines.length), ...lines]
}

function escapeAttr(value) {
  return String(value).replace(/[&"<>]/gu, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char])
}

/** 按一个详略级别渲染一次。 */
function render(material, input, level) {
  const { t, scope } = input
  const omitted = (count) => t('omitted', { count })
  const { turns } = material
  const sections = []

  const header = [input.relationText]
  const numbered = turns.filter((turn) => turn.turn !== null)
  if (numbered.length === 0) header.push(t('rangeEmptyTurns'))
  else if (numbered.length === 1) header.push(t('rangeTurn', { turn: numbered[0].turn }))
  else header.push(t('rangeTurns', { from: numbered[0].turn, to: numbered.at(-1).turn, count: numbered.length }))
  if (Number.isSafeInteger(input.previousTurn)) header.push(t('incremental', { turn: input.previousTurn }))
  if (material.running !== null) header.push(t('stillRunning', { turn: material.running }))
  if (typeof input.cwdNote === 'string' && input.cwdNote !== '') header.push(input.cwdNote)
  sections.push(`## ${t('sectionBranch')}\n${header.filter(Boolean).join('\n')}`)

  if (scope !== 'last') {
    const goal = material.goals.at(-1)
    if (goal !== undefined) sections.push(`## ${t('sectionGoal')}\n${t('goalObjective')}${t('colon')}${clip(goal, level.goal, omitted)}`)

    const detailed = Math.min(level.detailedTurns, turns.length)
    const brief = turns.length - detailed
    const head = Math.min(level.headTurns, brief)
    const tail = Math.max(0, Math.min(level.oneLiners - head, brief - head))
    const lines = []
    turns.forEach((turn, index) => {
      if (index >= brief) lines.push(turnDetail(t, turn, level, omitted))
      else if (index < head || index >= brief - tail) lines.push(turnOneLiner(t, turn, level))
      else if (index === head) lines.push(t('omittedTurns', { count: brief - head - tail }))
    })
    if (lines.length > 0) sections.push(`## ${t('sectionTurns')}\n${lines.join('\n')}`)

    const decisions = decisionLines(t, turns, level.decisions)
    if (decisions.length > 0) sections.push(`## ${t('sectionDecisions')}\n${decisions.join('\n')}`)
  }

  const files = fileLines(t, material.files, level.files)
  if (files.length > 0) sections.push(`## ${t('sectionFiles')}\n${files.join('\n')}`)

  if (scope !== 'last') {
    const commands = commandLines(t, turns, level.commands)
    if (commands.length > 0) sections.push(`## ${t('sectionCommands')}\n${commands.join('\n')}`)
    const todos = todoLines(t, material.todos, level.todos)
    if (todos.length > 0) sections.push(`## ${t('sectionTodos')}\n${todos.join('\n')}`)
    if (material.compaction !== null && level.compaction > 0) {
      sections.push(`## ${t('sectionCompaction')}\n${clip(material.compaction, level.compaction, omitted)}`)
    }
  }

  // 最后一条回复所在的轮次已经完整展开时，结论就在里面了
  const lastReplied = turns.findLast((turn) => turn.replies.length > 0)
  const expandedFrom = turns.length - Math.min(level.detailedTurns, turns.length)
  const expanded = scope !== 'last' && lastReplied !== undefined && turns.indexOf(lastReplied) >= expandedFrom
  if (!expanded) {
    const conclusion = lastReplied?.replies.at(-1)
    sections.push(`## ${t('sectionConclusion')}\n${conclusion === undefined ? t('noConclusion') : clip(conclusion, level.conclusion, omitted)}`)
  }
  if (typeof input.note === 'string' && input.note.trim() !== '') sections.push(`## ${t('sectionNote')}\n${input.note.trim()}`)

  const open = `<session-git-merge from="${escapeAttr(input.id)}" title="${escapeAttr(input.title)}" scope="${scope}">`
  return `${open}\n${t('preface')}\n\n${sections.join('\n\n')}\n</session-git-merge>`
}

const BASE_LEVEL = {
  detailedTurns: 0, prompt: 3000, reply: 4000, report: 1500, replies: 4, turnCommands: 8,
  goal: 1200, oneLiners: 30, headTurns: 3, decisions: 30, files: 60, commands: 20, todos: 30, compaction: 3000, conclusion: 6000
}

/** 详略级别，从详到略；full 从第一级开始试，summary/last 从 summaryStart 开始。 */
function levels(turnCount) {
  const steps = [turnCount, Math.ceil(turnCount / 2), 3, 1].map((detailedTurns) => ({ ...BASE_LEVEL, detailedTurns }))
  steps.push({ ...BASE_LEVEL, detailedTurns: 1, prompt: 1500, reply: 2500, replies: 2, report: 600 })
  const summaryStart = steps.length
  steps.push({ ...BASE_LEVEL, prompt: 160, reply: 240 })
  steps.push({ ...BASE_LEVEL, prompt: 120, reply: 160, oneLiners: 20, decisions: 20, files: 40, commands: 12, compaction: 2000, conclusion: 4000 })
  steps.push({ ...BASE_LEVEL, prompt: 80, reply: 100, oneLiners: 12, decisions: 12, files: 25, commands: 8, todos: 15, compaction: 1200, conclusion: 2500, goal: 600 })
  steps.push({ ...BASE_LEVEL, prompt: 60, reply: 60, oneLiners: 6, headTurns: 1, decisions: 6, files: 15, commands: 0, todos: 8, compaction: 0, conclusion: 1500, goal: 300 })
  return { steps, summaryStart }
}

/**
 * 生成合并摘要。
 * @param {object} input
 * @param {object[]} input.events 源会话的事件
 * @param {number} input.start 从这个 seq 开始（共同前缀，或上次合并之后）
 * @param {'summary'|'full'|'last'} [input.scope]
 * @param {number} [input.turns] 只要最近几轮，按完整记录展开
 * @returns {{ text: string, summary: string, stats: object }}
 */
export function buildDigest(input) {
  const { t } = input
  const material = collect(input.events, input.start, { titleOf: input.titleOf, workspaceChanges: input.workspaceChanges, cwd: input.cwd })
  const limited = Number.isSafeInteger(input.turns) && input.turns > 0
  const turns = limited && material.turns.length > input.turns ? material.turns.slice(-input.turns) : material.turns
  const scoped = { ...material, turns }
  const scope = input.scope === 'full' || input.scope === 'last' ? input.scope : 'summary'
  const maxChars = Number.isSafeInteger(input.maxChars) && input.maxChars >= 2000 ? input.maxChars : DEFAULT_MAX_CHARS
  const { steps, summaryStart } = levels(turns.length)
  const first = scope === 'full' || (limited && scope !== 'last') ? 0 : summaryStart
  const renderInput = { ...input, scope }

  let text = ''
  for (let index = first; index < steps.length; index += 1) {
    text = render(scoped, renderInput, steps[index])
    if (text.length <= maxChars) break
  }
  if (text.length > maxChars) {
    const closing = '\n</session-git-merge>'
    const kept = text.slice(0, maxChars - closing.length - 60).trimEnd()
    text = `${kept}\n${t('omitted', { count: text.length - kept.length })}${closing}`
  }

  const numbered = turns.filter((turn) => turn.turn !== null)
  const fromTurn = numbered[0]?.turn ?? null
  const toTurn = numbered.at(-1)?.turn ?? null
  const fileCount = material.files.size
  const range = fromTurn === toTurn ? t('rangeSingle', { turn: fromTurn }) : t('rangeShort', { from: fromTurn, to: toTurn })
  const summary = fromTurn === null
    ? t('summaryLineNoTurns', { title: input.title })
    : t(fileCount > 0 ? 'summaryLineFiles' : 'summaryLine', { title: input.title, range: range.trim(), files: fileCount })

  return {
    text,
    summary,
    stats: {
      empty: turns.length === 0,
      fromTurn,
      toTurn,
      turnCount: numbered.length,
      files: [...material.files.keys()],
      commandCount: turns.reduce((sum, turn) => sum + turn.commands.length, 0),
      failures: turns.reduce((sum, turn) => sum + turn.commands.filter((entry) => entry.call.failed).length, 0),
      decisions: turns.reduce((sum, turn) => sum + turn.decisions.length, 0),
      lastSeq: material.lastSeq,
      doneTurn: material.doneTurn,
      running: material.running
    }
  }
}
