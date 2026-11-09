import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LineageIndex } from '../lib/lineage.js'
import { fakeHost, header } from './fixtures.js'

// R ─┬─ A ── G
//    ├─ B
//    └─ S(子 agent) ── F
const HEADERS = [
  header('session-root0001', { createdAt: 100 }),
  header('session-aaaa1111', { createdAt: 200, parentSession: 'session-root0001' }),
  header('session-gggg3333', { createdAt: 400, parentSession: 'session-aaaa1111' }),
  header('session-bbbb2222', { createdAt: 300, parentSession: 'session-root0001' }),
  header('session-ssss4444', { createdAt: 250, parentSession: 'session-root0001', origin: 'subagent', delegationDepth: 1 }),
  header('session-ffff5555', { createdAt: 500, parentSession: 'session-ssss4444' }),
  header('session-other999', { createdAt: 50 })
]
const CUTS = { 'session-aaaa1111': 10, 'session-gggg3333': 20, 'session-bbbb2222': 15, 'session-ssss4444': 12, 'session-ffff5555': 30 }
const TITLES = { 'session-root0001': '主线', 'session-aaaa1111': '方案 A', 'session-gggg3333': '方案 A 细化', 'session-bbbb2222': '方案 B', 'session-ffff5555': '从子 agent 分出' }

function index() {
  const logs = Object.fromEntries(Object.entries(CUTS).map(([id, cut]) => [id, { cut, events: [] }]))
  const live = { 'session-root0001': { id: 'session-root0001', header: HEADERS[0], inheritedEventCount: 0 } }
  const snapshots = { 'session-root0001': { values: { title: TITLES['session-root0001'] } } }
  const cache = { cachedSnapshot: (meta) => (TITLES[meta.id] === undefined ? undefined : { asOfSeq: 0, values: { title: TITLES[meta.id] } }) }
  return new LineageIndex(fakeHost({ headers: HEADERS, logs, live, snapshots, services: { sessionProjectionCache: cache } }))
}

test('common prefix is the smallest cut below the lowest common ancestor', async () => {
  const lineage = await index().ensure()
  assert.deepEqual(await lineage.commonPrefix('session-aaaa1111', 'session-root0001'), { lca: 'session-root0001', prefix: 10 })
  assert.deepEqual(await lineage.commonPrefix('session-gggg3333', 'session-root0001'), { lca: 'session-root0001', prefix: 10 })
  assert.deepEqual(await lineage.commonPrefix('session-gggg3333', 'session-aaaa1111'), { lca: 'session-aaaa1111', prefix: 20 })
  assert.deepEqual(await lineage.commonPrefix('session-aaaa1111', 'session-bbbb2222'), { lca: 'session-root0001', prefix: 10 })
  assert.deepEqual(await lineage.commonPrefix('session-gggg3333', 'session-bbbb2222'), { lca: 'session-root0001', prefix: 10 })
  assert.equal(await lineage.commonPrefix('session-aaaa1111', 'session-other999'), null)
  assert.equal((await lineage.commonPrefix('session-bbbb2222', 'session-bbbb2222')).prefix, Infinity)
})

test('relations distinguish child, parent and other tree members', async () => {
  const lineage = await index().ensure()
  assert.equal(lineage.relation('session-aaaa1111', 'session-root0001'), 'child')
  assert.equal(lineage.relation('session-root0001', 'session-aaaa1111'), 'parent')
  assert.equal(lineage.relation('session-gggg3333', 'session-bbbb2222'), 'other')
  assert.equal(lineage.relation('session-other999', 'session-root0001'), null)
})

test('the tree hides subagents, keeps their branches, and numbers by creation time', async () => {
  const lineage = await index().ensure()
  const tree = lineage.treeOf('session-gggg3333')
  assert.equal(tree.root.id, 'session-root0001')
  assert.equal(tree.hidden, 1)
  const byId = Object.fromEntries(tree.entries.map((entry) => [entry.node.id, entry]))
  assert.equal(byId['session-ssss4444'], undefined)
  assert.equal(byId['session-ffff5555'].parentId, 'session-root0001')
  assert.deepEqual(tree.entries.map((entry) => [entry.node.id.slice(8, 12), entry.number]), [
    ['root', 0], ['aaaa', 1], ['gggg', 3], ['ffff', 4], ['bbbb', 2]
  ])
  assert.equal(byId['session-root0001'].subagents, 1)
  assert.deepEqual(lineage.childrenOf('session-root0001').map((node) => node.id), ['session-aaaa1111', 'session-bbbb2222'])
})

test('queries resolve by number, id prefix and title', async () => {
  const lineage = await index().ensure()
  const caller = 'session-root0001'
  assert.equal(lineage.resolve('#2', caller).match.node.id, 'session-bbbb2222')
  assert.equal(lineage.resolve('#0', 'session-aaaa1111').match.node.id, 'session-root0001')
  assert.equal(lineage.resolve('#0', caller).match, undefined)
  assert.equal(lineage.resolve('gggg', caller).match.node.id, 'session-gggg3333')
  assert.equal(lineage.resolve('session-bbbb2222', caller).match.node.id, 'session-bbbb2222')
  assert.equal(lineage.resolve('方案 B', caller).match.node.id, 'session-bbbb2222')
  assert.equal(lineage.resolve('细化', caller).match.node.id, 'session-gggg3333')
  const ambiguous = lineage.resolve('方案', caller)
  assert.equal(ambiguous.match, undefined)
  assert.equal(ambiguous.candidates.length, 3)
  assert.equal(lineage.resolve('other999', caller).outside.id, 'session-other999')
  assert.equal(lineage.resolve('nothing like this', caller).candidates.length, 0)
})

test('cuts come from live sessions first and are cached', async () => {
  const lineage = await index().ensure()
  let reads = 0
  const original = lineage.ctx.sessionQuery.readSession
  lineage.ctx.sessionQuery.readSession = async (id) => {
    reads += 1
    return original(id)
  }
  assert.equal(await lineage.cutOf('session-root0001'), 0)
  assert.equal(await lineage.cutOf('session-bbbb2222'), 15)
  assert.equal(await lineage.cutOf('session-bbbb2222'), 15)
  assert.equal(reads, 1)
})

test('new sessions are indexed without waiting for the next listing', async () => {
  const lineage = await index().ensure()
  lineage.add(header('session-cccc6666', { createdAt: 600, parentSession: 'session-root0001' }))
  assert.equal(lineage.isBranch('session-cccc6666'), true)
  assert.equal(lineage.treeOf('session-root0001').entries.find((entry) => entry.node.id === 'session-cccc6666').number, 5)
})
