import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDigest, collect, displayPath } from '../lib/digest.js'
import { createT } from '../lib/i18n.js'
import { SOURCE_KIND } from '../lib/util.js'
import { logBuilder } from './fixtures.js'

const zh = createT('zh')
const en = createT('en')

/** 共享历史 2 轮，分叉后又做了 2 轮。 */
function branchLog() {
  const log = logBuilder()
  log.turnStart(1)
  log.user('共享的第一轮')
  log.assistant(1, '共享的回复')
  log.turnEnd(1)
  log.turnStart(2)
  log.user('共享的第二轮')
  log.turnEnd(2)
  log.marker(true)
  const cut = log.seq - 1
  log.title('方案 A')
  log.turnStart(3)
  log.user('<system-reminder>内部提醒</system-reminder>试试用缓存重写列表页')
  log.call(3, 'c1', 'write', { file_path: '/work/src/list.js', content: 'x' })
  log.result(3, 'c1', 'ok')
  log.call(3, 'c2', 'edit', { file_path: '/work/src/list.js', old_string: 'a', new_string: 'b' })
  log.result(3, 'c2', 'ok')
  log.call(3, 'c3', 'str_replace_editor', { command: 'view', path: '/work/README.md' })
  log.result(3, 'c3', 'ok')
  log.call(3, 'c4', 'bash', { command: 'npm test', description: 'Run tests' })
  log.result(3, 'c4', 'Exit code 1\nfailing', false)
  log.call(3, 'c5', 'ask_user_question', { questions: [{ id: 'cache', header: '缓存策略', question: '用哪种缓存？' }] })
  log.result(3, 'c5', JSON.stringify({ answers: [{ id: 'cache', selected: ['内存缓存'], custom: '五分钟过期' }] }))
  log.assistant(3, '列表页改好了，测试还有一个失败。', '先想想')
  log.turnEnd(3)
  log.turnStart(4)
  log.user('修好那个测试')
  log.user('Agent x sent a message: 子任务做完了', { kind: 'agent-message', form: 'relay', senderSessionId: 'sub-1' })
  log.user('Background subagent x finished and will do no further work unless you send it more.Its closing message:子任务做完了（最终版）', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'sub-1' })
  log.user('合并内容', { kind: SOURCE_KIND, merge: { v: 1, from: 'session-other', through: 3, turn: 1 } })
  log.push('todo/write', { todos: [{ content: '修测试', status: 'completed' }, { content: '写文档', status: 'pending' }] })
  log.push('goal/change', { goal: { objective: '把列表页改成缓存版' } })
  log.call(4, 'c6', 'bash', { command: 'npm test' })
  log.result(4, 'c6', 'all passed')
  log.assistant(4, '测试全部通过。结论：缓存版列表页可以合并。')
  log.turnEnd(4)
  return { log, cut }
}

const base = (events, start, extra = {}) => ({
  t: zh,
  events,
  start,
  id: 'session-aaaa1111',
  title: '方案 A',
  relationText: '「方案 A」是本会话的分支。',
  cwd: '/work',
  titleOf: (id) => (id === 'session-other' ? '另一个分支' : id),
  ...extra
})

test('collect groups the branch events into turns and materials', () => {
  const { log, cut } = branchLog()
  const material = collect(log.events, cut, { cwd: '/work', home: '/home/me', titleOf: () => '另一个分支' })
  assert.deepEqual(material.turns.map((turn) => turn.turn), [3, 4])
  const [three, four] = material.turns
  assert.deepEqual(three.prompts, ['试试用缓存重写列表页'])
  assert.deepEqual(three.replies, ['列表页改好了，测试还有一个失败。'])
  assert.equal(three.commands[0].call.failed, true)
  assert.deepEqual(three.decisions, [{ question: '缓存策略', answer: '内存缓存 / 五分钟过期' }])
  assert.deepEqual([...material.files.keys()], ['src/list.js'])
  assert.deepEqual([...material.files.get('src/list.js').ops.keys()], ['write', 'edit'])
  assert.equal(four.reports.size, 1)
  assert.equal([...four.reports.values()][0], '子任务做完了（最终版）')
  assert.deepEqual(four.merges, ['另一个分支'])
  assert.equal(material.goals.at(-1), '把列表页改成缓存版')
  assert.equal(material.todos.length, 2)
  assert.equal(material.running, null)
  assert.equal(material.doneTurn, 4)
})

test('the summary digest carries every section and stays within budget', () => {
  const { log, cut } = branchLog()
  const digest = buildDigest(base(log.events, cut))
  const { text, stats } = digest
  assert.match(text, /^<session-git-merge from="session-aaaa1111" title="方案 A" scope="summary">/u)
  assert.match(text, /<\/session-git-merge>$/u)
  for (const heading of ['## 分支', '## 目标', '## 过程', '## 用户在分支里做的决定', '## 改动的文件', '## 执行的命令', '## 待办', '## 结论']) {
    assert.ok(text.includes(heading), heading)
  }
  assert.ok(text.includes('本次包含第 3–4 轮（2 轮）。'))
  assert.ok(text.includes('- src/list.js（write，edit）'))
  assert.ok(text.includes('`npm test`（失败） — Run tests'))
  assert.ok(text.includes('缓存策略 → 内存缓存 / 五分钟过期'))
  assert.ok(text.includes('并入了「另一个分支」'))
  assert.ok(text.includes('测试全部通过。结论：缓存版列表页可以合并。'))
  assert.ok(!text.includes('内部提醒'))
  assert.ok(!text.includes('先想想'))
  assert.ok(!text.includes('共享的'))
  assert.equal(digest.summary, '合并「方案 A」· 第 3–4 轮 · 1 个文件')
  assert.equal(stats.turnCount, 2)
  assert.equal(stats.failures, 1)
  assert.equal(stats.decisions, 1)
  assert.equal(stats.lastSeq, log.seq - 1)
})

test('full scope expands turns; last scope keeps only the conclusion and files', () => {
  const { log, cut } = branchLog()
  const full = buildDigest(base(log.events, cut, { scope: 'full' })).text
  assert.ok(full.includes('### 第 3 轮'))
  assert.ok(full.includes('**用户**：试试用缓存重写列表页'))
  assert.ok(full.includes('*子 agent 汇报*：子任务做完了（最终版）'))
  assert.ok(!full.includes('## 结论'), 'the last turn is already expanded')
  const last = buildDigest(base(log.events, cut, { scope: 'last' })).text
  assert.ok(!last.includes('## 过程'))
  assert.ok(last.includes('## 改动的文件'))
  assert.ok(last.includes('## 结论'))
})

test('turns limits the digest to the most recent turns', () => {
  const { log, cut } = branchLog()
  const digest = buildDigest(base(log.events, cut, { turns: 1 }))
  assert.equal(digest.stats.fromTurn, 4)
  assert.ok(digest.text.includes('### 第 4 轮'))
  assert.ok(!digest.text.includes('第 3 轮'))
})

test('a range starting inside a turn marks it as continued and reports running turns', () => {
  const log = logBuilder()
  log.turnStart(5)
  log.user('前半段')
  const start = log.seq
  log.assistant(5, '后半段的回复')
  log.turnEnd(5)
  log.turnStart(6)
  log.user('还在跑')
  const digest = buildDigest(base(log.events, start, { previousTurn: 4 }))
  assert.ok(digest.text.includes('第 5 轮（续）'))
  assert.ok(digest.text.includes('增量合并：上次合并到第 4 轮'))
  assert.ok(digest.text.includes('分支仍在运行，第 6 轮还没结束'))
  assert.equal(digest.stats.running, 6)
})

test('an empty range is reported as empty', () => {
  const { log } = branchLog()
  const digest = buildDigest(base(log.events, log.seq))
  assert.equal(digest.stats.empty, true)
  assert.equal(digest.summary, '合并「方案 A」')
})

test('oversized branches shrink step by step and never exceed the budget', () => {
  const log = logBuilder()
  for (let turn = 1; turn <= 80; turn += 1) {
    log.turnStart(turn)
    log.user(`第 ${turn} 个请求：${'很长的描述'.repeat(80)}`)
    log.call(turn, `c${turn}`, 'bash', { command: `run-step-${turn} ${'--flag '.repeat(30)}` })
    log.result(turn, `c${turn}`, 'ok')
    log.assistant(turn, `第 ${turn} 轮的回复：${'细节'.repeat(400)}`)
    log.turnEnd(turn)
  }
  for (const scope of ['summary', 'full', 'last']) {
    const digest = buildDigest(base(log.events, 0, { scope, maxChars: 6000 }))
    assert.ok(digest.text.length <= 6000, `${scope}: ${digest.text.length}`)
    assert.match(digest.text, /<\/session-git-merge>$/u)
  }
  const summary = buildDigest(base(log.events, 0, { maxChars: 12000 })).text
  assert.ok(summary.includes('中间省略'))
  assert.ok(summary.includes('第 80 轮'))
})

test('english digests use english labels and punctuation', () => {
  const { log, cut } = branchLog()
  const text = buildDigest(base(log.events, cut, { t: en, title: 'Plan A' })).text
  assert.ok(text.includes('## Files changed\n- src/list.js (write, edit)'))
  assert.ok(text.includes('`npm test` (failed) — Run tests'))
  assert.ok(text.includes('This merge covers turns 3–4 (2 turns).'))
})

test('display paths are relative to the working directory or home', () => {
  assert.equal(displayPath('/work/a/b.js', '/work', '/home/me'), 'a/b.js')
  assert.equal(displayPath('/home/me/notes.md', '/work', '/home/me'), '~/notes.md')
  assert.equal(displayPath('/etc/hosts', '/work', '/home/me'), '/etc/hosts')
  assert.equal(displayPath('C:\\work\\a.js', 'C:\\work', undefined), 'a.js')
})
