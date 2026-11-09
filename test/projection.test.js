import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, effectiveMerges, foldEvents, initState, stateSchema, viewOf, viewSchema } from '../lib/projection.js'
import { SOURCE_KIND } from '../lib/util.js'
import { logBuilder } from './fixtures.js'

const mergeSource = (from, through, turn) => ({ kind: SOURCE_KIND, form: 'notice', summary: 's', merge: { v: 1, from, through, turn } })

test('init records the cut and creation time', () => {
  const state = initState({ createdAt: 42 }, 17)
  assert.equal(state.cut, 17)
  assert.equal(state.born, 42)
  assert.equal(initState(undefined, undefined).cut, 0)
})

test('fork turn counts only turns started inside the inherited prefix', () => {
  const log = logBuilder()
  log.turnStart(1)
  log.turnEnd(1)
  log.turnStart(2)
  log.turnEnd(2)
  log.marker(true)
  const cut = log.seq - 1
  log.turnStart(3)
  log.turnEnd(3, 'aborted')
  log.turnStart(4)
  const state = foldEvents(log.events, cut, {})
  assert.equal(state.forkTurn, 2)
  assert.equal(state.turn, 4)
  assert.equal(state.doneTurn, 3)
})

test('unrelated events keep the same state reference', () => {
  const state = initState({}, 0)
  assert.equal(applyEvent(state, { type: 'step/start', seq: 1, data: { turn: 1 } }), state)
  assert.equal(applyEvent(state, { type: 'user/message', seq: 2, data: { source: { kind: 'user' } } }), state)
  assert.equal(applyEvent(state, null), state)
  assert.equal(applyEvent(state, { type: 'agent/inbox/spliced', seq: 3, data: { target: 'elsewhere' } }), state)
})

test('a queued merge is pending until claimed, then recorded', () => {
  const log = logBuilder()
  const message = { role: 'user', content: [], source: mergeSource('session-b', 120, 5), id: 'merge-1' }
  log.splice('next-step', 0, 0, [message])
  let state = foldEvents(log.events, 0, {})
  assert.deepEqual(Object.keys(state.pending), ['merge-1'])
  assert.equal(effectiveMerges(state)['session-b'].pending, true)
  assert.equal(effectiveMerges(state)['session-b'].through, 120)

  log.splice('next-step', 0, 1)
  log.push('user/message', message)
  state = foldEvents(log.events, 0, {})
  assert.deepEqual(state.pending, {})
  assert.deepEqual(state.inbox['next-step'], [])
  const merged = effectiveMerges(state)['session-b']
  assert.equal(merged.pending, false)
  assert.equal(merged.turn, 5)
  assert.equal(merged.n, 1)
})

test('a cancelled queue drops the pending merge', () => {
  const log = logBuilder()
  log.splice('next-turn', 0, 0, [{ id: 'other', source: { kind: 'user' } }, { id: 'merge-1', source: mergeSource('session-b', 9, 1) }])
  log.splice('next-turn', 0, 2)
  const state = foldEvents(log.events, 0, {})
  assert.deepEqual(effectiveMerges(state), {})
})

test('later merges keep the furthest position and count merges', () => {
  const log = logBuilder()
  log.user('digest', mergeSource('session-b', 50, 3))
  log.user('digest', mergeSource('session-b', 80, 4))
  log.user('digest', mergeSource('session-c', 10, 1))
  const merges = effectiveMerges(foldEvents(log.events, 0, {}))
  assert.equal(merges['session-b'].through, 80)
  assert.equal(merges['session-b'].n, 2)
  assert.equal(merges['session-c'].turn, 1)
})

test('tool results carrying sessionGit meta count as merges', () => {
  const log = logBuilder()
  log.result(1, 'call-1', 'digest', false, { sessionGit: { v: 1, from: 'session-b', through: 33, turn: 2 } })
  log.result(1, 'call-2', 'plain')
  const merges = effectiveMerges(foldEvents(log.events, 0, {}))
  assert.deepEqual(Object.keys(merges), ['session-b'])
  assert.equal(merges['session-b'].through, 33)
})

test('malformed merge metadata is ignored', () => {
  const log = logBuilder()
  log.user('x', { kind: SOURCE_KIND, merge: { from: 'session-b' } })
  log.user('x', { kind: SOURCE_KIND, merge: { from: '', through: 3 } })
  log.result(1, 'c', 'x', false, { sessionGit: 'nope' })
  assert.deepEqual(foldEvents(log.events, 0, {}).merges, {})
})

test('views are reused while their content is unchanged', () => {
  const a = foldEvents([], 0, { createdAt: 1 })
  const b = { ...a }
  assert.equal(viewOf(a), viewOf(b))
  assert.equal(viewSchema.parse(viewOf(a)), viewOf(a))
})

test('the state schema accepts folded states and rejects broken ones', () => {
  const log = logBuilder()
  log.splice('next-step', 0, 0, [{ id: 'merge-1', source: mergeSource('session-b', 1, 1) }])
  const state = foldEvents(log.events, 0, { createdAt: 5 })
  assert.equal(stateSchema.parse(state), state)
  assert.throws(() => stateSchema.parse({ ...state, cut: -0.5 }))
  assert.throws(() => stateSchema.parse({ ...state, inbox: { 'next-step': [1] } }))
  assert.throws(() => viewSchema.parse(null))
})
