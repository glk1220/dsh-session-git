/**
 * 会话 Git —— Client 半边。
 *
 *   - 右侧边栏「会话 Git」标签页：当前会话所在的分支树。每个分支显示从第几轮分出、
 *     自己做了几轮、合并到哪了；可以一键合并到当前会话、把本分支合并回父会话、打开分支。
 *   - 左侧栏「会话 Git」全局面板：工作区里所有分叉过的会话树。
 *   - 输入框上方的提示条：排队中的合并、子分支还没合并进来的进展（可一键合并或忽略）。
 *   - 输入框里单独敲 /merge 时弹出分支选择。
 *
 * 数据只来自标准的会话列表（每行带 sessionGit 投影视图）和 ctx.remote；合并动作就是在当前
 * 会话里执行 /merge，结果会作为命令卡片留在对话里。
 * 约束：不用 JSX、不用构建、不 require 其他 Harness 客户端包；样式只用 --dsw-alias-* 令牌。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-git',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionGit'
    const KEY = 'sessionGit'
    const PANEL_ID = 'session-git'
    const TAB_ID = 'dsh-session-git/map'
    const TAB_KIND = 'session-git'
    const STYLE_ID = 'dsh-session-git/style'
    const UP = '__up__'
    const EMPTY = Object.freeze([])

    const zh = {
      'title': '会话 Git',
      'guide.description': '分支地图：看 fork 出去的分支，把成果合并回来',
      'tab.hint': '当前会话所在的分支树。合并会把分支分叉后的工作整理成摘要，随你的下一条消息交给 agent。',
      'panel.hint': '工作区里所有分叉过的会话。点标题打开，点「合并到当前」把分支的工作带进当前会话。',
      'scope.label': '合并',
      'scope.summary': '摘要',
      'scope.full': '完整',
      'scope.last': '只要结论',
      'wake': '合并后立刻让 agent 处理',
      'action.merge': '合并到当前',
      'action.mergeUp': '合并回父会话',
      'action.open': '打开',
      'badge.current': '当前',
      'badge.running': '运行中',
      'badge.merged': '已合并',
      'badge.partly': '{count} 轮未合并',
      'badge.unmerged': '未合并',
      'badge.pending': '排队中',
      'meta.root': '主会话 · {count} 轮',
      'meta.forked': '第 {turn} 轮后分出 · 自有 {count} 轮',
      'meta.unknown': '读取中…',
      'meta.updated': '{time}',
      'subagents': '另有 {count} 个子 agent 会话没有显示',
      'empty.noSession': '先打开一个会话。',
      'empty.alone': '这个会话还没有分支。用会话菜单里的「分叉会话」或某条回复下的「在新对话中分支」开一个分支，探索完回到这里合并。',
      'empty.all': '这个工作区还没有分叉过的会话。',
      'scope.allWorkspaces': '显示所有工作区',
      'busy': '合并中…',
      'error.noCommand': '当前会话里没有 /merge 命令，会话 Git 的 Host 半边可能没有加载。',
      'error.failed': '执行失败：{reason}',
      'dismiss': '关闭',
      'popup.placeholder': '选择要合并进来的会话',
      'popup.empty': '当前会话没有可以合并的分支',
      'popup.noResults': '没有匹配的会话',
      'popup.up': '把本分支合并回「{title}」',
      'popup.group.up': '本分支',
      'popup.group.children': '分支',
      'popup.group.family': '同一棵树',
      'popup.detail': '{meta}',
      'tree.count': '{count} 个会话',
      'dock.pending.one': '已排队合并「{title}」（到第 {turn} 轮），{when}',
      'dock.pending.many': '已排队合并 {count} 个分支，{when}',
      'dock.when.idle': '会随你的下一条消息交给 agent',
      'dock.when.running': 'agent 下一步就会读到',
      'dock.unmerged.one': '分支「{title}」有 {count} 轮还没合并进来',
      'dock.unmerged.many': '{count} 个分支有还没合并进来的进展',
      'dock.row': '{count} 轮未合并',
      'action.ignore': '忽略',
      'action.expand': '展开',
      'action.collapse': '收起'
    }
    const en = {
      'title': 'Session Git',
      'guide.description': 'Branch map: see what you forked off and merge the results back',
      'tab.hint': 'The branch tree around this session. Merging turns a branch\'s work since the fork into a digest that reaches the agent with your next message.',
      'panel.hint': 'Every session tree in this workspace with forks. Click a title to open it; use “Merge here” to bring a branch\'s work into the current session.',
      'scope.label': 'Merge',
      'scope.summary': 'Summary',
      'scope.full': 'Full',
      'scope.last': 'Conclusion only',
      'wake': 'Let the agent act right away',
      'action.merge': 'Merge here',
      'action.mergeUp': 'Merge into parent',
      'action.open': 'Open',
      'badge.current': 'current',
      'badge.running': 'running',
      'badge.merged': 'merged',
      'badge.partly': '{count} turns not merged',
      'badge.unmerged': 'not merged',
      'badge.pending': 'queued',
      'meta.root': 'main session · {count} turns',
      'meta.forked': 'forked after turn {turn} · {count} own turns',
      'meta.unknown': 'loading…',
      'meta.updated': '{time}',
      'subagents': '{count} subagent sessions are not shown',
      'empty.noSession': 'Open a session first.',
      'empty.alone': 'This session has no branches yet. Use “Fork session” in the session menu or “Branch into a new conversation” under a reply, explore there, then come back here to merge.',
      'empty.all': 'No session in this workspace has been forked yet.',
      'scope.allWorkspaces': 'Show all workspaces',
      'busy': 'Merging…',
      'error.noCommand': 'This session has no /merge command; the Session Git Host half may not be loaded.',
      'error.failed': 'Failed: {reason}',
      'dismiss': 'Dismiss',
      'popup.placeholder': 'Pick a session to merge in',
      'popup.empty': 'This session has no branches to merge',
      'popup.noResults': 'No matching session',
      'popup.up': 'Merge this branch into “{title}”',
      'popup.group.up': 'This branch',
      'popup.group.children': 'Branches',
      'popup.group.family': 'Same tree',
      'popup.detail': '{meta}',
      'tree.count': '{count} sessions',
      'dock.pending.one': 'Merge from “{title}” (through turn {turn}) is queued; {when}',
      'dock.pending.many': 'Merges from {count} branches are queued; {when}',
      'dock.when.idle': 'it reaches the agent with your next message',
      'dock.when.running': 'the agent reads it at its next step',
      'dock.unmerged.one': 'Branch “{title}” has {count} turn(s) not merged here yet',
      'dock.unmerged.many': '{count} branches have work not merged here yet',
      'dock.row': '{count} turn(s) not merged',
      'action.ignore': 'Ignore',
      'action.expand': 'Show',
      'action.collapse': 'Hide'
    }

    const CSS = `
.sgit{box-sizing:border-box;height:100%;overflow:auto;padding:14px 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.sgit_head{display:flex;align-items:center;gap:8px;margin:0 0 4px}
.sgit_title{font-size:14px;font-weight:600}
.sgit_hint{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sgit_controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px}
.sgit_seg{display:inline-flex;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.sgit_seg button{border:0;padding:1px 8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.sgit_seg button+button{border-left:1px solid var(--dsw-alias-border-l1)}
.sgit_seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sgit_check{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.sgit_tree{display:flex;flex-direction:column;gap:2px;margin:0 0 14px}
.sgit_treehead{margin:0 0 4px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sgit_row{display:flex;align-items:flex-start;gap:6px;border-radius:6px;padding:4px 6px}
.sgit_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sgit_row_current{background:var(--dsw-alias-bg-layer-2)}
.sgit_guide{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre}
.sgit_dot{flex:none;box-sizing:border-box;width:9px;height:9px;margin-top:6px;border:1.5px solid var(--dsw-alias-label-tertiary);border-radius:50%}
.sgit_dot_running{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary)}
.sgit_dot_current{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.sgit_body{display:flex;flex:1 1 auto;flex-direction:column;min-width:0}
.sgit_line{display:flex;align-items:center;gap:6px;min-width:0}
.sgit_num{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.sgit_name{flex:0 1 auto;min-width:0;overflow:hidden;border:0;padding:0;background:transparent;color:inherit;font:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.sgit_name:hover{text-decoration:underline}
.sgit_badge{flex:none;border-radius:4px;padding:0 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.sgit_badge_warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.sgit_badge_ok{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.sgit_badge_live{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.sgit_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.sgit_actions{display:flex;flex:none;gap:6px;opacity:0;transition:opacity .12s}
.sgit_row:hover .sgit_actions,.sgit_row:focus-within .sgit_actions,.sgit_row_current .sgit_actions{opacity:1}
.sgit_btn{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.sgit_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sgit_btn_primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.sgit_btn_primary:hover{background:var(--dsw-alias-button-primary-hover)}
.sgit_btn[disabled]{opacity:.5;cursor:default}
.sgit_notice{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;border-radius:6px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;white-space:pre-wrap}
.sgit_notice_error{color:var(--dsw-alias-state-error-primary)}
.sgit_notice_text{flex:1 1 auto;min-width:0}
.sgit_empty{padding:8px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sgit_foot{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sgit_dock{box-sizing:border-box;flex:none;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 8px));max-width:calc(var(--dsh-composer-card-max-width, 768px) - 4 * var(--dsh-composer-dock-inset, 8px));margin:0 auto;overflow:hidden;border:0;border-radius:var(--dsw-radius-lg, 12px);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);background:var(--dsw-specific-menu, var(--dsw-alias-bg-base));backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.sgit_dock_body{display:flex;flex-direction:column;gap:6px;padding:6px 12px}
.sgit_dock_line{display:flex;align-items:center;gap:10px;min-width:0;min-height:24px}
.sgit_dock_lead{display:grid;flex:none;place-items:center;color:var(--dsw-alias-label-tertiary)}
.sgit_dock_text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sgit_dock_list{display:flex;flex-direction:column;gap:4px;max-height:160px;margin:0;padding:0 0 0 24px;overflow-y:auto;list-style:none}
.sgit_dock_error{color:var(--dsw-alias-state-error-primary)}
.sgit_grow{flex:1 1 auto}
.sgit_dock .sgit_actions{opacity:1}
.sgit_link{flex:none;border:0;padding:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.sgit_link:hover{color:var(--dsw-alias-label-primary)}
`

    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.setAttribute('data-plugin', 'dsh-session-git')
      tag.setAttribute('data-plugin-css', '')
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ------------------------------------------------------------------
    // 纯函数：从会话列表行构建分支树
    // ------------------------------------------------------------------

    const shortId = (id) => String(id ?? '').replace(/^session-/u, '').slice(0, 8)
    const isSubagent = (row) => row?.origin === 'subagent'
    const viewOf = (row) => {
      const view = row?.projectionValues?.[KEY]
      return view !== null && typeof view === 'object' ? view : undefined
    }
    const titleOf = (row) => row?.displayTitle || row?.title || shortId(row?.id)

    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function childIndex(byId) {
      const children = new Map()
      for (const row of Object.values(byId)) {
        if (row?.parentId === undefined || byId[row.parentId] === undefined) continue
        const list = children.get(row.parentId)
        if (list === undefined) children.set(row.parentId, [row])
        else list.push(row)
      }
      const born = (row) => viewOf(row)?.born ?? Number.MAX_SAFE_INTEGER
      for (const list of children.values()) list.sort((a, b) => born(a) - born(b) || String(a.id).localeCompare(String(b.id)))
      return children
    }

    function rootOf(byId, id) {
      let row = byId[id]
      const seen = new Set()
      while (row !== undefined && row.parentId !== undefined && byId[row.parentId] !== undefined && !seen.has(row.id)) {
        seen.add(row.id)
        row = byId[row.parentId]
      }
      return row
    }

    /** 一棵树按深度优先展开；子 agent 不显示，它下面的分支挂到最近的可见祖先上。 */
    function treeFrom(byId, children, root) {
      const entries = []
      let hidden = 0
      const visit = (row, depth, parent) => {
        if (isSubagent(row) && row !== root) {
          hidden += 1
          for (const child of children.get(row.id) ?? []) visit(child, depth, parent)
          return
        }
        const entry = { row, depth, parentId: parent?.row.id, number: 0, children: [] }
        if (parent !== undefined) parent.children.push(entry)
        entries.push(entry)
        for (const child of children.get(row.id) ?? []) visit(child, depth + 1, entry)
      }
      visit(root, 0, undefined)
      // 编号和 Host 一致：根是 #0，其余按创建时间；有会话缺创建时间时不显示编号
      const others = entries.filter((entry) => entry.row !== root)
      const numbered = others.every((entry) => Number.isSafeInteger(viewOf(entry.row)?.born))
      if (numbered) {
        others.slice().sort((a, b) => viewOf(a.row).born - viewOf(b.row).born || String(a.row.id).localeCompare(String(b.row.id)))
          .forEach((entry, index) => { entry.number = index + 1 })
      }
      for (const entry of entries) entry.label = entry.row === root ? '#0' : numbered ? `#${entry.number}` : ''
      // 连线前缀
      const prefix = (entry, ancestorsLast) => {
        entry.guide = entry.depth === 0 ? '' : `${ancestorsLast.slice(1, -1).map((last) => (last ? '   ' : '│  ')).join('')}${ancestorsLast.at(-1) ? '└─ ' : '├─ '}`
        entry.children.forEach((child, index) => prefix(child, [...ancestorsLast, index === entry.children.length - 1]))
      }
      prefix(entries[0], [true])
      return { root, entries, hidden }
    }

    /** 一个分支相对父会话的状态。parentView 可以传入更新鲜的父会话视图（比如 useProjection 拿到的）。 */
    function statusOf(entry, byId, parentView) {
      const view = viewOf(entry.row)
      if (view === undefined) return { known: false }
      const parent = parentView ?? (entry.parentId === undefined ? undefined : viewOf(byId[entry.parentId]))
      const merged = parent?.merges?.[entry.row.id]
      const own = Math.max(0, view.doneTurn - view.forkTurn)
      const unmerged = merged === undefined ? own : Math.max(0, view.doneTurn - Math.max(merged.turn, view.forkTurn))
      return { known: true, view, merged, own, unmerged }
    }

    /** 合并状态：pending（排队中）/ merged / partly（合并过但又有新轮次）/ unmerged / null（没什么可合并的）。 */
    function mergeState(status) {
      if (!status.known) return null
      if (status.merged?.pending) return 'pending'
      if (status.merged !== undefined) return status.unmerged === 0 ? 'merged' : 'partly'
      return status.own > 0 ? 'unmerged' : null
    }
    const BADGE_CLASS = { pending: 'sgit_badge', merged: 'sgit_badge sgit_badge_ok', partly: 'sgit_badge sgit_badge_warn', unmerged: 'sgit_badge sgit_badge_warn' }
    function mergeBadge(status, t) {
      const state = mergeState(status)
      return state === null ? '' : t(`badge.${state}`, { count: status.unmerged })
    }

    function familyOf(byId, currentId) {
      if (currentId === undefined || byId[currentId] === undefined) return undefined
      const root = rootOf(byId, currentId)
      return root === undefined ? undefined : treeFrom(byId, childIndex(byId), root)
    }

    function currentIdOf(byId) {
      for (const row of Object.values(byId)) if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
      return undefined
    }

    function mergeLine(target, scope, wake) {
      return ['/merge', target === UP ? '--up' : target, scope === 'summary' ? '' : scope, wake ? '--wake' : ''].filter(Boolean).join(' ')
    }

    // ------------------------------------------------------------------
    // 组件
    // ------------------------------------------------------------------

    function useMergeRunner(runCommand, t) {
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const run = React.useCallback(async (sessionId, target, scope, wake) => {
        setBusy(target)
        setNotice(null)
        try {
          const result = await runCommand(sessionId, mergeLine(target, scope, wake))
          setNotice({ error: result.kind === 'error', text: result.text ?? '' })
        } catch (error) {
          setNotice({ error: true, text: t('error.failed', { reason: String(error?.message ?? error) }) })
        } finally {
          setBusy(null)
        }
      }, [runCommand, t])
      return { busy, notice, run, dismiss: () => setNotice(null) }
    }

    /** 缺 sessionGit 视图的冷会话：请会话列表去读一次投影（每个会话只请求一次）。 */
    const requested = new Set()
    function useFillViews(entries, refreshProjections) {
      React.useEffect(() => {
        if (typeof refreshProjections !== 'function') return
        let budget = 12
        for (const entry of entries) {
          if (budget <= 0) break
          if (viewOf(entry.row) !== undefined || requested.has(entry.row.id)) continue
          requested.add(entry.row.id)
          budget -= 1
          Promise.resolve(refreshProjections(entry.row.id)).catch(() => {})
        }
      }, [entries, refreshProjections])
    }

    function Controls({ scope, setScope, wake, setWake, t, extra }) {
      const choice = (value) => h('button', { type: 'button', 'aria-pressed': scope === value, onClick: () => setScope(value) }, t(`scope.${value}`))
      return h('div', { className: 'sgit_controls' },
        h('span', null, t('scope.label')),
        h('span', { className: 'sgit_seg', role: 'group' }, choice('summary'), choice('full'), choice('last')),
        h('label', { className: 'sgit_check' },
          h('input', { type: 'checkbox', checked: wake, onChange: (event) => setWake(event.target.checked) }),
          t('wake')),
        extra ?? null)
    }

    function Notice({ notice, dismiss, t }) {
      if (notice === null) return null
      return h('div', { className: `sgit_notice${notice.error ? ' sgit_notice_error' : ''}`, role: 'status' },
        h('span', { className: 'sgit_notice_text' }, notice.text),
        h('button', { type: 'button', className: 'sgit_btn', onClick: dismiss }, t('dismiss')))
    }

    function Badges({ entry, status, currentId, t }) {
      const badges = []
      if (entry.row.id === currentId) badges.push(h('span', { key: 'current', className: 'sgit_badge' }, t('badge.current')))
      if (entry.row.running === true) badges.push(h('span', { key: 'running', className: 'sgit_badge sgit_badge_live' }, t('badge.running')))
      if (entry.parentId !== undefined) {
        const state = mergeState(status)
        if (state !== null) badges.push(h('span', { key: 'm', className: BADGE_CLASS[state] }, t(`badge.${state}`, { count: status.unmerged })))
      }
      return badges
    }

    function Row({ entry, byId, currentId, inFamily, busy, onMerge, onOpen, t }) {
      const { row } = entry
      const status = statusOf(entry, byId)
      const isCurrent = row.id === currentId
      const meta = !status.known
        ? t('meta.unknown')
        : entry.parentId === undefined
          ? t('meta.root', { count: status.view.doneTurn })
          : t('meta.forked', { turn: status.view.forkTurn, count: status.own })
      const clock = formatClock(row.updatedAt)
      const actions = []
      if (inFamily && isCurrent && entry.parentId !== undefined) {
        actions.push(h('button', { key: 'up', type: 'button', className: 'sgit_btn sgit_btn_primary', disabled: busy !== null, onClick: () => onMerge(UP) }, busy === UP ? t('busy') : t('action.mergeUp')))
      }
      if (inFamily && !isCurrent && currentId !== undefined) {
        actions.push(h('button', { key: 'merge', type: 'button', className: 'sgit_btn sgit_btn_primary', disabled: busy !== null, onClick: () => onMerge(row.id) }, busy === row.id ? t('busy') : t('action.merge')))
      }
      if (!isCurrent) actions.push(h('button', { key: 'open', type: 'button', className: 'sgit_btn', onClick: () => onOpen(row.id) }, t('action.open')))
      const dot = isCurrent ? 'sgit_dot sgit_dot_current' : row.running === true ? 'sgit_dot sgit_dot_running' : 'sgit_dot'
      return h('div', { className: `sgit_row${isCurrent ? ' sgit_row_current' : ''}`, 'data-session-id': row.id },
        entry.guide === '' ? null : h('span', { className: 'sgit_guide', 'aria-hidden': true }, entry.guide),
        h('span', { className: dot, 'aria-hidden': true }),
        h('div', { className: 'sgit_body' },
          h('div', { className: 'sgit_line' },
            entry.label === '' ? null : h('span', { className: 'sgit_num' }, entry.label),
            h('button', { type: 'button', className: 'sgit_name', title: `${titleOf(row)} (${shortId(row.id)})`, onClick: () => (isCurrent ? undefined : onOpen(row.id)) }, titleOf(row)),
            Badges({ entry, status, currentId, t })),
          h('div', { className: 'sgit_meta' }, `${shortId(row.id)} · ${meta}${clock === '' ? '' : ` · ${clock}`}`)),
        actions.length === 0 ? null : h('div', { className: 'sgit_actions' }, actions))
    }

    function Tree({ tree, byId, currentId, inFamily, busy, onMerge, onOpen, t, heading }) {
      return h('div', { className: 'sgit_tree', role: 'list' },
        heading === undefined ? null : h('div', { className: 'sgit_treehead' }, heading),
        tree.entries.map((entry) => h(Row, { key: entry.row.id, entry, byId, currentId, inFamily, busy, onMerge, onOpen, t })),
        tree.hidden > 0 ? h('div', { className: 'sgit_foot' }, t('subagents', { count: tree.hidden })) : null)
    }

    /** 右侧边栏标签页：当前会话所在的那棵树。 */
    function MapTab(props) {
      const { useSessions, t, runCommand, openSession, refreshProjections } = props
      const byId = useSessions((state) => state.byId)
      const currentId = props.sessionId ?? currentIdOf(byId)
      const tree = React.useMemo(() => familyOf(byId, currentId), [byId, currentId])
      const [scope, setScope] = React.useState('summary')
      const [wake, setWake] = React.useState(false)
      const runner = useMergeRunner(runCommand, t)
      useFillViews(tree?.entries ?? EMPTY, refreshProjections)
      const alone = tree === undefined || tree.entries.length <= 1
      return h('div', { className: 'sgit', 'data-session-git': 'tab' },
        h('p', { className: 'sgit_hint' }, t('tab.hint')),
        currentId === undefined
          ? h('div', { className: 'sgit_empty' }, t('empty.noSession'))
          : alone
            ? h('div', { className: 'sgit_empty' }, t('empty.alone'))
            : h(React.Fragment, null,
              h(Controls, { scope, setScope, wake, setWake, t }),
              h(Notice, { notice: runner.notice, dismiss: runner.dismiss, t }),
              h(Tree, {
                tree, byId, currentId, inFamily: true, busy: runner.busy, t,
                onMerge: (target) => runner.run(currentId, target, scope, wake),
                onOpen: openSession
              })))
    }

    /** 左侧栏全局面板：工作区里所有分叉过的会话树，当前会话的树排在最前。 */
    function MapPanel(props) {
      const { useSessions, t, runCommand, openSession, refreshProjections } = props
      const byId = useSessions((state) => state.byId)
      const currentId = currentIdOf(byId)
      const [allWorkspaces, setAllWorkspaces] = React.useState(false)
      const [scope, setScope] = React.useState('summary')
      const [wake, setWake] = React.useState(false)
      const runner = useMergeRunner(runCommand, t)
      const cwd = currentId === undefined ? undefined : byId[currentId]?.cwd
      const trees = React.useMemo(() => {
        const children = childIndex(byId)
        const roots = Object.values(byId).filter((row) => row !== undefined && (row.parentId === undefined || byId[row.parentId] === undefined))
        const result = []
        for (const root of roots) {
          if (!allWorkspaces && cwd !== undefined && root.cwd !== cwd) continue
          const tree = treeFrom(byId, children, root)
          if (tree.entries.length <= 1) continue
          tree.latest = Math.max(...tree.entries.map((entry) => entry.row.updatedAt ?? 0))
          tree.hasCurrent = tree.entries.some((entry) => entry.row.id === currentId)
          result.push(tree)
        }
        return result.sort((a, b) => Number(b.hasCurrent) - Number(a.hasCurrent) || b.latest - a.latest)
      }, [byId, cwd, allWorkspaces, currentId])
      const entries = React.useMemo(() => trees.flatMap((tree) => tree.entries), [trees])
      useFillViews(entries, refreshProjections)
      const toggle = h('label', { className: 'sgit_check' },
        h('input', { type: 'checkbox', checked: allWorkspaces, onChange: (event) => setAllWorkspaces(event.target.checked) }),
        t('scope.allWorkspaces'))
      return h('div', { className: 'sgit', 'data-session-git': 'panel' },
        h('div', { className: 'sgit_head' }, h(SessionGitIcon, { size: 18 }), h('span', { className: 'sgit_title' }, t('title'))),
        h('p', { className: 'sgit_hint' }, t('panel.hint')),
        h(Controls, { scope, setScope, wake, setWake, t, extra: toggle }),
        h(Notice, { notice: runner.notice, dismiss: runner.dismiss, t }),
        trees.length === 0
          ? h('div', { className: 'sgit_empty' }, t('empty.all'))
          : trees.map((tree) => h(Tree, {
            key: tree.root.id, tree, byId, currentId, inFamily: tree.hasCurrent, busy: runner.busy, t,
            heading: t('tree.count', { count: tree.entries.length }),
            onMerge: (target) => runner.run(currentId, target, scope, wake),
            onOpen: openSession
          })))
    }

    /**
     * 「忽略」过的分支：记下忽略时它完成到第几轮，分支之后再有新的一轮就重新提示。
     * 存在 localStorage 里，只留最近 200 条。
     */
    const DISMISS_KEY = 'dsh-session-git:ignored'
    function readIgnored() {
      try {
        const value = JSON.parse(window.localStorage.getItem(DISMISS_KEY) ?? '{}')
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      } catch {
        return {}
      }
    }
    function useIgnored() {
      const [ignored, setIgnored] = React.useState(readIgnored)
      const ignore = React.useCallback((id, turn) => {
        setIgnored((current) => {
          const next = { ...current, [id]: turn }
          const keys = Object.keys(next)
          for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete next[key]
          try {
            window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next))
          } catch {}
          return next
        })
      }, [])
      return [ignored, ignore]
    }

    /**
     * 输入框上方的提示条，只看当前会话：
     *   - 有排队中的合并时说明它什么时候交给 agent（静默合并在对话里不显示，这里是唯一的痕迹）；
     *   - 直接分出去的分支有还没合并进来的轮次时，给出「合并 / 忽略」。
     */
    function MergeDock(props) {
      const { useSessions, useProjection, sessionId, t, runCommand, openSession, refreshProjections } = props
      const byId = useSessions((state) => state.byId)
      const live = typeof useProjection === 'function' ? useProjection(KEY) : undefined
      const ownView = live !== null && typeof live === 'object' ? live : viewOf(byId[sessionId])
      const running = byId[sessionId]?.running === true
      const [ignored, ignore] = useIgnored()
      const [open, setOpen] = React.useState(false)
      const runner = useMergeRunner(runCommand, t)
      const children = React.useMemo(() => {
        const tree = familyOf(byId, sessionId)
        return tree === undefined ? EMPTY : tree.entries.filter((entry) => entry.parentId === sessionId)
      }, [byId, sessionId])
      useFillViews(children, refreshProjections)

      const pending = Object.entries(ownView?.merges ?? {}).filter(([, merge]) => merge?.pending === true)
      const unmerged = []
      for (const entry of children) {
        const status = statusOf(entry, byId, ownView)
        const state = mergeState(status)
        if (state !== 'partly' && state !== 'unmerged') continue
        if ((ignored[entry.row.id] ?? -1) >= status.view.doneTurn) continue
        unmerged.push({ entry, status })
      }
      const error = runner.notice?.error ? runner.notice.text : null
      if (pending.length === 0 && unmerged.length === 0 && error === null) return null

      const when = t(running ? 'dock.when.running' : 'dock.when.idle')
      const lead = h('span', { className: 'sgit_dock_lead', 'aria-hidden': true }, h(SessionGitIcon, { size: 14 }))
      const actionsFor = ({ entry, status }) => h('div', { className: 'sgit_actions' },
        h('button', {
          type: 'button', className: 'sgit_btn sgit_btn_primary', disabled: runner.busy !== null,
          onClick: () => runner.run(sessionId, entry.row.id, 'summary', false)
        }, runner.busy === entry.row.id ? t('busy') : t('action.merge')),
        h('button', { type: 'button', className: 'sgit_btn', onClick: () => ignore(entry.row.id, status.view.doneTurn) }, t('action.ignore')))

      const lines = []
      if (pending.length > 0) {
        const [from, merge] = pending[0]
        lines.push(h('div', { key: 'pending', className: 'sgit_dock_line' }, lead,
          h('span', { className: 'sgit_dock_text', title: titleOf(byId[from]) },
            pending.length === 1
              ? t('dock.pending.one', { title: titleOf(byId[from] ?? { id: from }), turn: merge.turn, when })
              : t('dock.pending.many', { count: pending.length, when }))))
      }
      if (unmerged.length === 1) {
        const item = unmerged[0]
        const row = item.entry.row
        lines.push(h('div', { key: 'unmerged', className: 'sgit_dock_line' }, lead,
          item.entry.label === '' ? null : h('span', { className: 'sgit_num' }, item.entry.label),
          h('button', { type: 'button', className: 'sgit_name sgit_dock_text', title: `${titleOf(row)} (${shortId(row.id)})`, onClick: () => openSession(row.id) },
            t('dock.unmerged.one', { title: titleOf(row), count: item.status.unmerged })),
          actionsFor(item)))
      } else if (unmerged.length > 1) {
        lines.push(h('div', { key: 'unmerged', className: 'sgit_dock_line' }, lead,
          h('span', { className: 'sgit_dock_text' }, t('dock.unmerged.many', { count: unmerged.length })),
          h('button', { type: 'button', className: 'sgit_link', 'aria-expanded': open, onClick: () => setOpen((value) => !value) },
            t(open ? 'action.collapse' : 'action.expand'))))
        if (open) {
          lines.push(h('ul', { key: 'list', className: 'sgit_dock_list' }, unmerged.map((item) => h('li', { key: item.entry.row.id, className: 'sgit_dock_line' },
            item.entry.label === '' ? null : h('span', { className: 'sgit_num' }, item.entry.label),
            h('button', { type: 'button', className: 'sgit_name', title: `${titleOf(item.entry.row)} (${shortId(item.entry.row.id)})`, onClick: () => openSession(item.entry.row.id) },
              titleOf(item.entry.row)),
            h('span', { className: 'sgit_meta' }, shortId(item.entry.row.id)),
            h('span', { className: 'sgit_grow' }),
            h('span', { className: 'sgit_badge sgit_badge_warn' }, t('dock.row', { count: item.status.unmerged })),
            actionsFor(item)))))
        }
      }
      if (error !== null) {
        lines.push(h('div', { key: 'error', className: 'sgit_dock_line sgit_dock_error', role: 'status' }, lead,
          h('span', { className: 'sgit_dock_text', title: error }, error),
          h('button', { type: 'button', className: 'sgit_link', onClick: runner.dismiss }, t('dismiss'))))
      }
      return h('section', { className: 'sgit_dock', 'data-session-git': 'dock', 'aria-label': t('title') },
        h('div', { className: 'sgit_dock_body' }, lines))
    }

    function SessionGitIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true, className: props?.className
      },
      h('circle', { cx: 4.5, cy: 3.5, r: 1.8 }),
      h('circle', { cx: 4.5, cy: 12.5, r: 1.8 }),
      h('circle', { cx: 11.5, cy: 6.5, r: 1.8 }),
      h('path', { d: 'M4.5 5.3v5.4M11.5 8.3c0 2.2-1.6 3-4 3.4L6.2 12' }))
    }

    /** /merge 弹窗的选项：父会话（推送）、子分支、同一棵树里的其他会话。 */
    function popupOptions(byId, sessionId, t) {
      const tree = familyOf(byId, sessionId)
      if (tree === undefined || tree.entries.length <= 1) return []
      const self = tree.entries.find((entry) => entry.row.id === sessionId)
      const options = []
      // 只给直接相关的两种选项标合并状态：子分支（合并进当前会话）和本分支（推送回父会话）
      const describe = (entry, withStatus) => {
        const status = statusOf(entry, byId)
        if (!status.known) return shortId(entry.row.id)
        const parts = [shortId(entry.row.id), entry.parentId === undefined
          ? t('meta.root', { count: status.view.doneTurn })
          : t('meta.forked', { turn: status.view.forkTurn, count: status.own })]
        const badge = withStatus ? mergeBadge(status, t) : ''
        if (badge !== '') parts.push(badge)
        return parts.join(' · ')
      }
      if (self?.parentId !== undefined) {
        options.push({ id: UP, label: t('popup.up', { title: titleOf(byId[self.parentId]) }), detail: describe(self, true), group: { name: 'up', label: t('popup.group.up') } })
      }
      for (const entry of tree.entries) {
        if (entry.row.id === sessionId) continue
        const child = entry.parentId === sessionId
        options.push({
          id: entry.row.id,
          label: `${entry.label === '' ? '' : `${entry.label} `}${titleOf(entry.row)}`,
          detail: describe(entry, child),
          group: child ? { name: 'children', label: t('popup.group.children') } : { name: 'family', label: t('popup.group.family') }
        })
      }
      // 子分支排在前面
      const rank = (option) => (option.group.name === 'up' ? 0 : option.group.name === 'children' ? 1 : 2)
      return options.sort((a, b) => rank(a) - rank(b))
    }

    return {
      name: 'dsh-session-git',
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions'],

      apply(ctx) {
        ctx.effect(installStyles, 'session-git: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-git: dictionaries')
        const t = ctx.locale.bind(NS)

        const runCommand = async (sessionId, line) => {
          const result = await ctx.remote.commands.execute(sessionId, line, [])
          if (!result.ok) throw new Error(result.error?.message ?? String(result.error?.code ?? 'error'))
          if (result.value === undefined) return { kind: 'error', text: t('error.noCommand') }
          return result.value.result
        }
        const openSession = (id) => {
          const workspace = ctx.get('uiWorkspace')
          if (typeof workspace?.openSession === 'function') workspace.openSession(id)
        }
        const refreshProjections = (id) => ctx.sessions.refreshProjections?.(id)
        const face = () => ({ runCommand, openSession, refreshProjections })

        // 右侧边栏标签页
        ctx.inject(['sidebarRightTabs'], function sessionGitTab(ctx) {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => t('title'),
            guide: [{ id: 'map', order: 60, title: () => t('title'), description: () => t('guide.description'), icon: SessionGitIcon }]
          }), 'session-git: sidebar tab type')
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            inject: face
          }, MapTab)), 'session-git: sidebar tab body')
        })

        // 左侧栏全局面板
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: face
        }, MapPanel)), 'session-git: main panel')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('title'),
          locale: NS
        }, SessionGitIcon)), 'session-git: sidebar entry')

        // 输入框上方的提示条（排在待办、排队消息之后）
        ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'session-git',
          order: 30,
          label: () => t('title'),
          locale: NS,
          inject: face
        }, MergeDock)), 'session-git: composer dock')

        // 单独输入 /merge 时弹出选择
        ctx.inject(['commandUi'], function sessionGitMergePopup(ctx) {
          const optionsFor = (sessionId) => popupOptions(ctx.sessions.list.getSnapshot().byId, sessionId, t)
          ctx.effect(() => ctx.commandUi.decorate({
            name: 'merge',
            available: (session) => optionsFor(session.sessionId).length > 0,
            ui: {
              kind: 'popupSelect',
              searchLabels: () => ({ placeholder: t('popup.placeholder'), empty: t('popup.empty'), noResults: t('popup.noResults') }),
              options: async (session) => optionsFor(session.sessionId),
              onSelect: async (option, session) => {
                await runCommand(session.sessionId, mergeLine(option.id, 'summary', false))
              }
            }
          }), 'session-git: /merge popup')
        })
      }
    }
  }
})
