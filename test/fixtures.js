/**
 * 测试用的合成会话日志（不含任何真实会话内容）。
 */

export function logBuilder(start = 0) {
  let seq = start
  const events = []
  const push = (type, data = {}) => {
    const event = { type, seq, time: 1_800_000_000_000 + seq, data }
    seq += 1
    events.push(event)
    return event
  }
  const text = (value) => [{ type: 'text', text: value }]
  return {
    events,
    get seq() {
      return seq
    },
    push,
    turnStart: (turn) => push('turn/start', { turn }),
    turnEnd: (turn, kind = 'completed') => push('turn/end', { turn, reason: { kind } }),
    user: (value, source = { kind: 'user' }) => push('user/message', { role: 'user', content: text(value), source, id: `m${seq}` }),
    assistant: (turn, value, reasoning) => push('assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', content: [...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []), ...text(value)] }
    }),
    call: (turn, callId, name, args) => push('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) }),
    result: (turn, callId, value, isError = false, meta) => push('tool/result', {
      turn,
      step: 1,
      message: { role: 'tool', toolCallId: callId, content: text(value), isError },
      ...(meta === undefined ? {} : { meta })
    }),
    splice: (target, start, removedCount, inserted = []) => push('agent/inbox/spliced', { target, start, ...(removedCount ? { removedCount } : {}), inserted }),
    marker: (inherited) => push('session/end-seed', inherited ? { inherited: true } : {}),
    title: (value) => push('session/title', { title: value })
  }
}

/** 一个最小的 Host ctx：会话头部、日志、投影快照都由测试提供。 */
export function fakeHost({ headers, logs = {}, live = {}, snapshots = {}, services = {} }) {
  return {
    sessionQuery: {
      async listSessions() {
        return headers.map((header) => ({ header, live: header.id in live, persisted: true }))
      },
      async readSession(id) {
        const log = logs[id]
        if (log === undefined) throw new Error(`session "${id}" not found`)
        return { session: headers.find((header) => header.id === id), inheritedEventCount: log.cut, events: log.events }
      }
    },
    sessions: {
      list: () => Object.values(live),
      get: (id) => live[id]
    },
    sessionProjections: {
      snapshot: (session) => snapshots[session.id],
      stateOf: (session) => session.state
    },
    get: (name) => services[name]
  }
}

export function header(id, extra = {}) {
  return { type: 'session', version: 4, id, createdAt: extra.createdAt ?? 1_800_000_000_000, cwd: '/work', isSeeded: extra.parentSession !== undefined, ...extra }
}
