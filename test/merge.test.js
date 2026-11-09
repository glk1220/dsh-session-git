import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMergeInput, runBranches, runMerge } from '../lib/commands.js'
import { createT } from '../lib/i18n.js'
import { LineageIndex } from '../lib/lineage.js'
import { deliver, mergeMessage, prepareMerge } from '../lib/merge.js'
import { applyEvent, foldEvents } from '../lib/projection.js'
import { SOURCE_KIND } from '../lib/util.js'
import { fakeHost, header, logBuilder } from './fixtures.js'

const zh = createT('zh')
const ROOT = 'session-root0001'
const BRANCH = 'session-aaaa1111'
const SIBLING = 'session-bbbb2222'

function sharedHistory(log) {
  log.turnStart(1)
  log.user('共享')
  log.assistant(1, '共享回复')
  log.turnEnd(1)
}

/** 根会话 + 两个分支；根会话是存活的 agent。 */
function world() {
  const root = logBuilder()
  sharedHistory(root)
  root.turnStart(2)
  root.user('主线继续')
  root.assistant(2, '主线的进展')
  root.turnEnd(2)

  const branch = logBuilder()
  sharedHistory(branch)
  branch.marker(true)
  const branchCut = branch.seq - 1
  branch.title('方案 A')
  branch.turnStart(2)
  branch.user('探索方案 A')
  branch.assistant(2, '方案 A 可行')
  branch.turnEnd(2)

  const sibling = logBuilder()
  sharedHistory(sibling)
  sibling.marker(true)
  const siblingCut = sibling.seq - 1
  sibling.title('方案 B')

  const headers = [
    header(ROOT, { createdAt: 100 }),
    header(BRANCH, { createdAt: 200, parentSession: ROOT }),
    header(SIBLING, { createdAt: 300, parentSession: ROOT })
  ]
  const calls = []
  const agent = (id, log) => {
    const session = {
      id,
      header: headers.find((item) => item.id === id),
      inheritedEventCount: 0,
      state: foldEvents(log.events, 0, {}),
      seq: log.seq,
      snapshotEvents: () => log.events
    }
    return {
      id,
      session,
      inject: (message) => {
        calls.push(['inject', id, message])
        session.state = applyEvent(session.state, { type: 'user/message', seq: 999, time: 1, data: message })
      },
      followup: (message) => calls.push(['followup', id, message])
    }
  }
  const rootAgent = agent(ROOT, root)
  const branchAgent = agent(BRANCH, branch)
  branchAgent.session.inheritedEventCount = branchCut
  const titles = { [ROOT]: '主线', [BRANCH]: '方案 A', [SIBLING]: '方案 B' }
  const controller = {
    prompt: async (request) => {
      calls.push(['prompt', request.sessionId, request.content[0].text])
      return { accepted: true }
    },
    resolveAgent: async (id) => (id === ROOT ? { agent: rootAgent } : { error: new Error('nope') })
  }
  const ctx = fakeHost({
    headers,
    logs: { [ROOT]: { cut: 0, events: root.events }, [BRANCH]: { cut: branchCut, events: branch.events }, [SIBLING]: { cut: siblingCut, events: sibling.events } },
    live: { [ROOT]: rootAgent.session, [BRANCH]: branchAgent.session },
    snapshots: {},
    services: {
      sessionController: controller,
      sessionProjectionCache: { cachedSnapshot: (meta) => ({ asOfSeq: 0, values: { title: titles[meta.id] } }) }
    }
  })
  ctx.sessionProjections.snapshot = (session) => ({ values: { title: titles[session.id] } })
  ctx.sessionProjections.stateOf = (session) => session.state
  const env = { ctx, lineage: new LineageIndex(ctx), config: { maxDigestChars: 24000, locale: 'zh', tools: true } }
  return { env, calls, rootAgent, branchAgent, branchCut, branch }
}

const invoke = (agent, rawInput) => ({ agent, rawInput, signal: new AbortController().signal, commandId: 'cmd-1' })

test('parseMergeInput understands scopes, flags, numbers and notes', () => {
  assert.deepEqual(parseMergeInput(' #2 full --wake -- 接着做'), { query: '#2', scope: 'full', turns: undefined, wake: true, fresh: false, up: false, note: '接着做' })
  assert.equal(parseMergeInput('2').query, '#2')
  assert.equal(parseMergeInput('3轮').turns, 3)
  assert.equal(parseMergeInput('turns:4 方案 A').query, '方案 A')
  assert.equal(parseMergeInput('"方案 A" 最后').scope, 'last')
  assert.equal(parseMergeInput('--all').fresh, true)
  assert.equal(parseMergeInput('-u').up, true)
  assert.equal(parseMergeInput('-- 只有附言').note, '只有附言')
  assert.equal(parseMergeInput('--bogus').error, '--bogus')
  assert.equal(parseMergeInput('12345678').query, '12345678')
})

test('prepareMerge starts after the shared history and builds the message', async () => {
  const { env, branchCut } = world()
  const prepared = await prepareMerge({ ...env, t: zh }, { sourceId: BRANCH, targetId: ROOT })
  assert.equal(prepared.relation, 'child')
  assert.equal(prepared.start, branchCut)
  assert.equal(prepared.empty, false)
  assert.equal(prepared.merge.from, BRANCH)
  assert.equal(prepared.merge.turn, 2)
  assert.ok(prepared.digest.text.includes('「方案 A」（aaaa1111）是本会话的分支，从第 1 轮之后分出。'))
  assert.ok(!prepared.digest.text.includes('共享回复'))
  const message = mergeMessage(prepared)
  assert.equal(message.source.kind, SOURCE_KIND)
  assert.equal(message.source.form, 'notice')
  assert.ok(Object.isFrozen(message))
})

test('a second merge only takes what is new', async () => {
  const { env, branch } = world()
  const first = await prepareMerge({ ...env, t: zh }, { sourceId: BRANCH, targetId: ROOT })
  const targetMerges = { [BRANCH]: { through: first.merge.through, turn: first.merge.turn, pending: false } }
  const again = await prepareMerge({ ...env, t: zh }, { sourceId: BRANCH, targetId: ROOT, targetMerges })
  assert.equal(again.empty, true)
  branch.turnStart(3)
  branch.user('再加一点')
  branch.assistant(3, '加好了')
  branch.turnEnd(3)
  const third = await prepareMerge({ ...env, t: zh }, { sourceId: BRANCH, targetId: ROOT, targetMerges })
  assert.equal(third.digest.stats.fromTurn, 3)
  assert.ok(third.digest.text.includes('增量合并：上次合并到第 2 轮'))
  const fresh = await prepareMerge({ ...env, t: zh }, { sourceId: BRANCH, targetId: ROOT, targetMerges, fresh: true })
  assert.equal(fresh.digest.stats.fromTurn, 2)
})

test('deliver injects silently, wakes on request, and sends notes as prompts', async () => {
  const { env, calls, rootAgent } = world()
  const message = { id: 'm' }
  assert.equal(await deliver(env, rootAgent, message), 'silent')
  assert.equal(await deliver(env, rootAgent, message, { wake: true }), 'wake')
  assert.equal(await deliver(env, rootAgent, message, { note: '继续' }), 'note')
  assert.deepEqual(calls.map(([kind]) => kind), ['inject', 'followup', 'inject', 'prompt'])
  assert.equal(calls.at(-1)[2], '继续')
})

test('/merge without arguments merges the only branch with content', async () => {
  const { env, calls, rootAgent } = world()
  const result = await runMerge(env, invoke(rootAgent, ''))
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.startsWith('已把「方案 A」第 2 轮合并进来'), result.text)
  assert.equal(calls[0][0], 'inject')
  const repeat = await runMerge(env, invoke(rootAgent, '#1'))
  assert.ok(repeat.text.includes('没有新内容'), repeat.text)
})

test('/merge lists branches when there are several and reports unknown queries', async () => {
  const { env, rootAgent } = world()
  const missing = await runMerge(env, invoke(rootAgent, '不存在的分支'))
  assert.equal(missing.kind, 'error')
  assert.ok(missing.text.includes('#1 方案 A'), missing.text)
  const empty = await runMerge(env, invoke(rootAgent, '#2'))
  assert.ok(empty.text.includes('还没有新内容'), empty.text)
  const bad = await runMerge(env, invoke(rootAgent, '--nope'))
  assert.equal(bad.kind, 'error')
  assert.ok(bad.text.includes('用法'))
})

test('/merge inside a branch pushes it into the parent', async () => {
  const { env, calls, branchAgent } = world()
  const result = await runMerge(env, invoke(branchAgent, ''))
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('合并到「主线」'), result.text)
  assert.deepEqual(calls.map(([kind, id]) => [kind, id]), [['inject', ROOT]])
})

test('/merge with a note sends it after the digest', async () => {
  const { env, calls, rootAgent } = world()
  const result = await runMerge(env, invoke(rootAgent, '#1 -- 基于方案 A 继续'))
  assert.ok(result.text.includes('附言'), result.text)
  assert.deepEqual(calls.map(([kind]) => kind), ['inject', 'prompt'])
})

test('/branches renders the map', async () => {
  const { env, rootAgent } = world()
  const result = await runBranches(env, invoke(rootAgent, ''))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^会话地图 · 3 个会话/u)
  assert.ok(result.text.includes('├─ #1 方案 A（aaaa1111） · 第 1 轮后分出 · 自有 1 轮 · 未合并'), result.text)
  assert.ok(result.text.includes('└─ #2 方案 B（bbbb2222） · 第 1 轮后分出 · 自有 0 轮'), result.text)
})

/** 让根会话的 inject 只进收件箱（排队中），不立刻落成 user/message。 */
function queueInsteadOfClaim(rootAgent, calls) {
  rootAgent.inject = (message) => {
    calls.push(['inject', ROOT, message])
    rootAgent.session.state = applyEvent(rootAgent.session.state, {
      type: 'agent/inbox/spliced', seq: 998, time: 1, data: { target: 'next-step', start: 0, inserted: [message] }
    })
  }
}

test('/merge with a note while that merge is still queued sends the note anyway', async () => {
  const { env, calls, rootAgent } = world()
  queueInsteadOfClaim(rootAgent, calls)
  assert.equal((await runMerge(env, invoke(rootAgent, '#1'))).kind, 'success')
  const result = await runMerge(env, invoke(rootAgent, '#1 -- 接着做'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已经在排队/u)
  assert.deepEqual(calls.map(([kind]) => kind), ['inject', 'prompt'])
  assert.equal(calls[1][2], '接着做')
})

test('/merge with a note and nothing new says the note was not sent', async () => {
  const { env, calls, rootAgent } = world()
  await runMerge(env, invoke(rootAgent, '#1'))
  const result = await runMerge(env, invoke(rootAgent, '#1 -- 接着做'))
  assert.match(result.text, /没有新内容/u)
  assert.match(result.text, /附言没有发出/u)
  assert.deepEqual(calls.map(([kind]) => kind), ['inject'])
})
