window.__ModuleLoader__.load({
  id: 'dsh-swarm',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'dshSwarm'
    const API = '/swarm/api'

    const DICT = {
      en: {
        navLabel: 'Swarm',
        title: 'Swarm',
        subtitle: 'Controlled multi-agent runs: task market, isolated worktrees, review gates, and budget.',
        refresh: 'Refresh',
        loading: 'Loading…',
        error: 'Could not load swarm state',
        noRuns: 'No swarm runs yet',
        noRunsHint: 'Start one from a conversation with swarm_start, or run node scripts/demo.mjs to see the flow.',
        run: 'Run',
        tabOverview: 'Overview',
        tabMembers: 'Members',
        tabTasks: 'Tasks',
        tabTopology: 'Topology',
        tabHive: 'Hive',
        tabTimeline: 'Timeline',
        tabBudget: 'Budget',
        goal: 'Goal',
        repo: 'Repository',
        base: 'Base commit',
        integration: 'Integration branch',
        autoDispatch: 'Auto dispatch',
        gate: 'Gate',
        on: 'on',
        off: 'off',
        none: 'none',
        status: 'Status',
        round: 'Round',
        concurrency: 'Concurrency',
        members: 'Members',
        tasks: 'Tasks',
        merged: 'Merged',
        active: 'Active',
        events: 'Events',
        converged: 'Converged',
        lastEvents: 'Recent events',
        noEvents: 'No events yet.',
        emptyMembers: 'No members in this run.',
        emptyTasks: 'No tasks in this run yet.',
        name: 'Member',
        role: 'Role',
        load: 'Load',
        done: 'Done',
        failed: 'Failed',
        currentTasks: 'Current tasks',
        worktree: 'Worktree',
        assignee: 'Assignee',
        state: 'State',
        attempts: 'Attempts',
        merge: 'Merge',
        patch: 'Patch',
        conflict: 'Conflict',
        budgetRun: 'Run budget',
        used: 'Used',
        limit: 'Limit',
        reserved: 'Reserved',
        calls: 'Calls',
        usd: 'Cost (USD)',
        wall: 'Wall clock',
        perTask: 'Per task',
        perMember: 'Per member',
        scope: 'Scope',
        tokens: 'Tokens',
        worktreeOn: 'worktree isolation',
        worktreeOff: 'patch-only',
        degraded: 'degraded',
        conflicts: 'conflicts',
        queue: 'Merge queue',
        noReview: 'no reviewers',
        topologyTitle: 'Member topology',
        nodes: 'Nodes',
        edges: 'Edges',
        noTopology: 'At least two members are needed to draw a topology.',
        exportCsv: 'Export CSV',
        boardTitle: 'Blackboard',
        pheromoneTitle: 'Pheromones',
        messagesTitle: 'Messages',
        noBoard: 'No blackboard entries yet.',
        noPheromones: 'No pheromone trails yet.',
        noMessages: 'No messages yet.',
        timelineTitle: 'Event timeline',
        play: 'Play',
        pause: 'Pause',
        stepBack: 'Prev',
        stepForward: 'Next',
        eventPayload: 'Event payload',
        eventsLoaded: 'events',
        loadFailed: 'Could not load events',
        costByTask: 'Cost by task',
        costByMember: 'Cost by member',
        costByRole: 'Cost by role',
        noCost: 'No spend recorded yet.',
        unknown: '—',
      },
      zh: {
        navLabel: '蜂群',
        title: '蜂群',
        subtitle: '受控多 agent 运行：任务市场、独立 worktree、评审门禁与预算。',
        refresh: '刷新',
        loading: '加载中…',
        error: '无法加载蜂群状态',
        noRuns: '还没有蜂群运行',
        noRunsHint: '在会话里用 swarm_start 启动一次，或运行 node scripts/demo.mjs 查看完整流程。',
        run: '运行',
        tabOverview: '概览',
        tabMembers: '成员',
        tabTasks: '任务',
        tabTopology: '拓扑',
        tabHive: '蜂巢',
        tabTimeline: '时间线',
        tabBudget: '预算',
        goal: '目标',
        repo: '仓库',
        base: '基线提交',
        integration: '集成分支',
        autoDispatch: '自动派发',
        gate: '门禁',
        on: '开',
        off: '关',
        none: '无',
        status: '状态',
        round: '轮次',
        concurrency: '并发上限',
        members: '成员',
        tasks: '任务',
        merged: '已合并',
        active: '进行中',
        events: '事件',
        converged: '已收敛',
        lastEvents: '最近事件',
        noEvents: '还没有事件。',
        emptyMembers: '这次运行没有成员。',
        emptyTasks: '这次运行还没有任务。',
        name: '成员',
        role: '角色',
        load: '负载',
        done: '完成',
        failed: '失败',
        currentTasks: '当前任务',
        worktree: '工作区',
        assignee: '负责人',
        state: '状态',
        attempts: '尝试',
        merge: '合并',
        patch: '补丁',
        conflict: '冲突',
        budgetRun: '运行预算',
        used: '已用',
        limit: '上限',
        reserved: '预留',
        calls: '调用',
        usd: '费用（USD）',
        wall: '墙钟',
        perTask: '按任务',
        perMember: '按成员',
        scope: '范围',
        tokens: 'Token',
        worktreeOn: 'worktree 隔离',
        worktreeOff: '仅补丁',
        degraded: '降级',
        conflicts: '冲突',
        queue: '合并队列',
        noReview: '无评审',
        topologyTitle: '成员拓扑',
        nodes: '节点',
        edges: '边',
        noTopology: '至少两名成员才能绘制拓扑。',
        exportCsv: '导出 CSV',
        boardTitle: '黑板',
        pheromoneTitle: '信息素',
        messagesTitle: '消息',
        noBoard: '暂无黑板条目。',
        noPheromones: '暂无信息素轨迹。',
        noMessages: '暂无消息。',
        timelineTitle: '事件时间线',
        play: '播放',
        pause: '暂停',
        stepBack: '上一步',
        stepForward: '下一步',
        eventPayload: '事件载荷',
        eventsLoaded: '条事件',
        loadFailed: '无法加载事件',
        costByTask: '任务成本',
        costByMember: '成员成本',
        costByRole: '角色成本',
        noCost: '暂无消耗记录。',
        unknown: '—',
      },
    }

    let translate = (key) => key
    let subscribeLocale = null

    const CSS = `
      .dshs-root {
        --dshs-radius: 10px;
        height: 100%; min-height: 0;
        display: flex; flex-direction: column;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 1.5;
        overflow: hidden;
      }
      .dshs-header { flex: none; padding: 18px 24px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
      .dshs-header-main { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; max-width: 1040px; margin: 0 auto; }
      .dshs-title-wrap { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
      .dshs-logo { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 9px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); }
      .dshs-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
      .dshs-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; max-width: 640px; }
      .dshs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dshs-select { height: 30px; max-width: 280px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
      .dshs-button { height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
      .dshs-button:hover { border-color: var(--dsw-alias-border-l2); }
      .dshs-tabs { display: flex; gap: 2px; max-width: 1040px; margin: 14px auto 0; }
      .dshs-tab { appearance: none; border: 0; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 8px 11px 10px; font: inherit; font-size: 12.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
      .dshs-tab:hover { color: var(--dsw-alias-label-primary); }
      .dshs-tab-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .dshs-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px 40px; }
      .dshs-inner { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
      .dshs-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: var(--dshs-radius); padding: 13px; }
      .dshs-muted { color: var(--dsw-alias-label-secondary); }
      .dshs-small { font-size: 11.5px; }
      .dshs-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      .dshs-stat { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: var(--dshs-radius); padding: 11px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .dshs-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dshs-stat strong { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
      .dshs-meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 18px; }
      .dshs-meta { min-width: 0; }
      .dshs-meta-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dshs-meta-value { overflow-wrap: anywhere; font-size: 12.5px; }
      .dshs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .dshs-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
      .dshs-table td { padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
      .dshs-table tr:last-child td { border-bottom: 0; }
      .dshs-graph { width: 100%; height: auto; max-height: 540px; display: block; margin-top: 8px; }
      .dshs-graph text { font-family: inherit; }
      .dshs-feed-item { padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dshs-feed-item:last-child { border-bottom: 0; }
      .dshs-feed-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dshs-badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }
      .dshs-feed-body { margin-top: 4px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .dshs-feed-meta { margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
      .dshs-timeline-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
      .dshs-timeline-controls input { flex: 1; min-width: 160px; accent-color: var(--dsw-alias-brand-primary); }
      .dshs-timeline { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 12px; }
      .dshs-event-list { max-height: 460px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
      .dshs-event-item { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 6px 9px; cursor: pointer; }
      .dshs-event-item:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); }
      .dshs-event-item-active { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); border-left: 2px solid var(--dsw-alias-brand-primary); }
      .dshs-payload { margin: 8px 0 0; max-height: 380px; overflow: auto; padding: 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .dshs-cost-row { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(80px, 2fr) auto; gap: 10px; align-items: center; padding: 4px 0; font-size: 11.5px; }
      .dshs-cost-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
      .dshs-cost-track { height: 7px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); overflow: hidden; }
      .dshs-cost-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
      .dshs-cost-value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
      @media (max-width: 760px) { .dshs-timeline { grid-template-columns: minmax(0, 1fr); } }
      .dshs-pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
      .dshs-state-running, .dshs-state-working, .dshs-state-approved { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); }
      .dshs-state-paused, .dshs-state-blocked, .dshs-state-reviewing, .dshs-state-bidding, .dshs-state-submitted { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
      .dshs-state-aborted, .dshs-state-failed, .dshs-state-cancelled { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
      .dshs-state-converged, .dshs-state-merged, .dshs-state-idle, .dshs-state-awarded { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
      .dshs-bar { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent); overflow: hidden; }
      .dshs-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
      .dshs-banner { padding: 9px 12px; border-radius: 8px; font-size: 12px; }
      .dshs-banner-error { color: var(--dsw-alias-state-error-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
      .dshs-empty { padding: 36px 18px; text-align: center; color: var(--dsw-alias-label-secondary); }
      .dshs-empty strong { display: block; color: var(--dsw-alias-label-primary); font-size: 14px; margin-bottom: 6px; }
      .dshs-events { display: flex; flex-direction: column; gap: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
      .dshs-event { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dshs-event:last-child { border-bottom: 0; }
      .dshs-event-seq { width: 34px; color: var(--dsw-alias-label-secondary); text-align: right; }
      .dshs-section-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
      @media (max-width: 820px) {
        .dshs-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .dshs-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 560px) {
        .dshs-header, .dshs-scroll { padding-left: 14px; padding-right: 14px; }
        .dshs-stats, .dshs-meta-grid { grid-template-columns: minmax(0, 1fr); }
      }
    `

    async function api(path, signal) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function fmtTime(ts) {
      if (!ts) return translate('unknown')
      try {
        return new Date(ts).toLocaleTimeString()
      } catch {
        return translate('unknown')
      }
    }

    function shortSha(value) {
      if (!value) return translate('unknown')
      return String(value).slice(0, 8)
    }

    function shortId(value) {
      if (!value) return translate('unknown')
      const text = String(value)
      return text.length > 14 ? `…${text.slice(-8)}` : text
    }

    function StatusPill({ value }) {
      return h('span', { className: `dshs-pill dshs-state-${value}` }, value)
    }

    function Meta({ label, value }) {
      return h('div', { className: 'dshs-meta' },
        h('div', { className: 'dshs-meta-label' }, label),
        h('div', { className: 'dshs-meta-value' }, value || translate('unknown')),
      )
    }

    function Stat({ label, value, hint }) {
      return h('div', { className: 'dshs-stat' },
        h('span', { className: 'dshs-stat-label' }, label),
        h('strong', null, value),
        hint ? h('span', { className: 'dshs-muted dshs-small' }, hint) : null,
      )
    }

    function BudgetBar({ used, limit }) {
      const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100
      return h('div', null,
        h('div', { className: 'dshs-bar' }, h('div', { className: 'dshs-bar-fill', style: { width: `${pct}%` } })),
        h('div', { className: 'dshs-muted dshs-small' }, `${used} / ${limit} (${pct}%)`),
      )
    }

    function Overview({ data }) {
      const stats = data.stats || {}
      const budget = data.budget || {}
      const runBudget = budget.run || {}
      const limits = budget.limits || {}
      const workspace = data.workspace || {}
      const dispatch = data.dispatch || {}
      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('div', { className: 'dshs-meta-grid' },
            h(Meta, { label: translate('goal'), value: data.goal }),
            h(Meta, { label: translate('repo'), value: data.repo }),
            h(Meta, { label: translate('base'), value: shortSha(data.baseCommit) }),
            h(Meta, { label: translate('integration'), value: workspace.integrationBranch }),
            h(Meta, { label: translate('gate'), value: (data.gateCommands || []).join(', ') || translate('none') }),
            h(Meta, { label: translate('autoDispatch'), value: dispatch.auto ? translate('on') : translate('off') }),
            h(Meta, { label: translate('round'), value: data.round ?? 1 }),
            h(Meta, { label: translate('concurrency'), value: data.concurrencyLimit ?? translate('unknown') }),
          ),
        ),
        h('div', { className: 'dshs-stats' },
          h(Stat, { key: 'status', label: translate('status'), value: h(StatusPill, { value: data.status }) }),
          h(Stat, { key: 'members', label: translate('members'), value: stats.members ?? 0 }),
          h(Stat, { key: 'tasks', label: translate('tasks'), value: `${stats.merged ?? 0} / ${stats.tasks ?? 0}` }),
          h(Stat, { key: 'active', label: translate('active'), value: stats.active ?? 0 }),
        ),
        h('div', { className: 'dshs-card' },
          h('h3', { className: 'dshs-section-title' }, translate('budgetRun')),
          h(BudgetBar, { used: runBudget.tokens ?? 0, limit: limits.runTokens ?? 0 }),
          h('div', { className: 'dshs-muted dshs-small', style: { marginTop: 6 } },
            `${translate('calls')} ${runBudget.calls ?? 0} · ${translate('usd')} ${(runBudget.usd ?? 0).toFixed(4)} · ${translate('reserved')} ${runBudget.reservedTokens ?? 0}`,
          ),
        ),
        data.convergedReason
          ? h('div', { className: 'dshs-banner dshs-banner-error' }, `${translate('converged')}: ${data.convergedReason}`)
          : null,
        h('div', { className: 'dshs-card' },
          h('h3', { className: 'dshs-section-title' }, translate('lastEvents')),
          (data.events || []).length === 0
            ? h('span', { className: 'dshs-muted' }, translate('noEvents'))
            : h('div', { className: 'dshs-events' },
                [...(data.events || [])].reverse().slice(0, 20).map((event) =>
                  h('div', { key: event.seq, className: 'dshs-event' },
                    h('span', { className: 'dshs-event-seq' }, event.seq),
                    h('span', { className: 'dshs-grow' }, event.type),
                    h('span', { className: 'dshs-muted' }, fmtTime(event.at)),
                  ),
                ),
              ),
        ),
      )
    }

    function Members({ data }) {
      const members = data.members || []
      const tasks = data.tasks || []
      const activeStates = new Set(['awarded', 'working', 'submitted', 'reviewing', 'approved'])
      if (members.length === 0) return h('div', { className: 'dshs-card dshs-empty' }, translate('emptyMembers'))
      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('table', { className: 'dshs-table' },
            h('thead', null, h('tr', null,
              h('th', null, translate('name')),
              h('th', null, translate('role')),
              h('th', null, translate('status')),
              h('th', null, translate('load')),
              h('th', null, translate('done')),
              h('th', null, translate('currentTasks')),
            )),
            h('tbody', null, members.map((member) => {
              const current = tasks
                .filter((task) => task.assignee === member.id && activeStates.has(task.state))
                .map((task) => task.title)
              return h('tr', { key: member.id },
                h('td', null,
                  h('div', null, member.name),
                  h('div', { className: 'dshs-muted dshs-small' }, shortId(member.id)),
                ),
                h('td', null, member.role),
                h('td', null, h(StatusPill, { value: member.status })),
                h('td', null, member.load ?? 0),
                h('td', null, `${member.stats?.done ?? 0} / ${member.stats?.failed ?? 0}`),
                h('td', null, current.length ? current.join('; ') : translate('none')),
              )
            })),
          ),
        ),
      )
    }

    function Tasks({ data }) {
      const tasks = data.tasks || []
      if (tasks.length === 0) return h('div', { className: 'dshs-card dshs-empty' }, translate('emptyTasks'))
      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('table', { className: 'dshs-table' },
            h('thead', null, h('tr', null,
              h('th', null, translate('tasks')),
              h('th', null, translate('state')),
              h('th', null, translate('assignee')),
              h('th', null, translate('worktree')),
              h('th', null, translate('gate')),
              h('th', null, translate('attempts')),
            )),
            h('tbody', null, tasks.map((task) => h('tr', { key: task.id },
              h('td', null,
                h('div', null, task.title),
                h('div', { className: 'dshs-muted dshs-small' }, task.id),
                task.lastConflict
                  ? h('div', { className: 'dshs-small', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                      `${translate('conflict')}: ${(task.lastConflict.files || []).join(', ') || task.lastConflict.reason}`)
                  : null,
              ),
              h('td', null, h(StatusPill, { value: task.state })),
              h('td', null, task.assignee ? shortId(task.assignee) : translate('none')),
              h('td', null, task.worktree
                ? h('span', { title: task.worktree.path }, task.worktree.branch ? shortId(task.worktree.branch) : translate('none'))
                : translate('worktreeOff')),
              h('td', null, task.gate
                ? h('span', { className: task.gate.passed ? 'dshs-state-approved' : 'dshs-state-failed' },
                    `${task.gate.passed ? 'pass' : 'fail'} (${(task.gate.checks || []).length})`)
                : translate('none')),
              h('td', null, task.attempts ?? 0),
            ))),
          ),
        ),
      )
    }

    function Topology({ data }) {
      const topology = data.topologyGraph || { nodes: [], edges: [] }
      const nodes = topology.nodes || []
      const edges = topology.edges || []
      if (nodes.length < 2) {
        return h('div', { className: 'dshs-card dshs-empty' }, translate('noTopology'))
      }
      const width = 840
      const height = 520
      const cx = width / 2
      const cy = height / 2
      const radius = Math.min(190, 80 + nodes.length * 7)
      const positions = new Map()
      nodes.forEach((node, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / nodes.length
        positions.set(node.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
      })
      const roleColor = {
        queen: 'var(--dsw-alias-brand-primary)',
        worker: 'var(--dsw-alias-state-success-primary)',
        reviewer: 'var(--dsw-alias-state-warn-primary)',
        judge: 'var(--dsw-alias-label-primary)',
      }
      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('h3', { className: 'dshs-section-title' }, translate('topologyTitle')),
          h('div', { className: 'dshs-muted dshs-small' },
            `${translate('nodes')}: ${nodes.length} · ${translate('edges')}: ${edges.length}`),
          h('svg', { className: 'dshs-graph', viewBox: `0 0 ${width} ${height}`, role: 'img' },
            edges.map((edge, index) => {
              const from = positions.get(edge.from)
              const to = positions.get(edge.to)
              if (!from || !to) return null
              const review = edge.kind === 'review'
              return h('line', {
                key: `edge-${index}`,
                x1: from.x,
                y1: from.y,
                x2: to.x,
                y2: to.y,
                stroke: review ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)',
                strokeWidth: Math.min(4, 1 + edge.weight * 0.5),
                strokeOpacity: 0.55,
                strokeDasharray: review ? undefined : '5 4',
              })
            }),
            nodes.map((node) => {
              const point = positions.get(node.id)
              const color = roleColor[node.role] || 'var(--dsw-alias-label-secondary)'
              return h('g', { key: node.id },
                h('circle', {
                  cx: point.x,
                  cy: point.y,
                  r: 16,
                  fill: 'var(--dsw-alias-bg-base)',
                  stroke: color,
                  strokeWidth: node.status === 'busy' ? 3 : 2,
                }),
                h('text', {
                  x: point.x,
                  y: point.y + 28,
                  textAnchor: 'middle',
                  fontSize: 11,
                  fill: 'var(--dsw-alias-label-primary)',
                }, node.name),
                h('text', {
                  x: point.x,
                  y: point.y + 41,
                  textAnchor: 'middle',
                  fontSize: 9,
                  fill: 'var(--dsw-alias-label-secondary)',
                }, `${node.role} · ${node.status} · ${node.done}/${node.failed}`),
              )
            }),
          ),
        ),
      )
    }

    function Hive({ data }) {
      const board = data.board || []
      const pheromones = data.pheromones || []
      const messages = data.messages || []
      const boardCard = h('div', { className: 'dshs-card' },
        h('h3', { className: 'dshs-section-title' }, translate('boardTitle')),
        board.length === 0
          ? h('div', { className: 'dshs-empty' }, translate('noBoard'))
          : board.slice(0, 40).map((entry) => h('div', { className: 'dshs-feed-item', key: entry.id },
              h('div', { className: 'dshs-feed-head' },
                h('span', { className: 'dshs-badge' }, entry.kind),
                h('span', { className: 'dshs-badge' }, entry.topic),
                h('span', { className: 'dshs-muted dshs-small' }, `${Math.round((entry.confidence ?? 0) * 100)}%`),
              ),
              h('div', { className: 'dshs-feed-body' }, entry.content),
              h('div', { className: 'dshs-feed-meta' },
                `${shortId(entry.author)} · ${fmtTime(entry.updatedAt)}${entry.expiresAt ? ` · ttl ${fmtTime(entry.expiresAt)}` : ''}`),
            )),
      )
      const pheromoneCard = h('div', { className: 'dshs-card' },
        h('h3', { className: 'dshs-section-title' }, translate('pheromoneTitle')),
        pheromones.length === 0
          ? h('div', { className: 'dshs-empty' }, translate('noPheromones'))
          : pheromones.slice(0, 30).map((item) => h('div', { className: 'dshs-feed-item', key: `${item.topic}:${item.kind}` },
              h('div', { className: 'dshs-feed-head' },
                h('span', { className: 'dshs-badge' }, item.kind),
                h('span', { className: 'dshs-feed-body' }, item.topic),
                h('span', { className: 'dshs-muted dshs-small' }, `${(item.strength ?? item.weight ?? 0).toFixed?.(2) ?? item.strength ?? ''}`),
              ),
            )),
      )
      const messageCard = h('div', { className: 'dshs-card' },
        h('h3', { className: 'dshs-section-title' }, translate('messagesTitle')),
        messages.length === 0
          ? h('div', { className: 'dshs-empty' }, translate('noMessages'))
          : messages.slice(-30).reverse().map((message) => h('div', { className: 'dshs-feed-item', key: message.id },
              h('div', { className: 'dshs-feed-head' },
                h('span', { className: 'dshs-badge' }, message.kind),
                h('span', { className: 'dshs-feed-body' }, `${shortId(message.from)} → ${message.to.startsWith('topic:') ? message.to : shortId(message.to)}`),
                h('span', { className: 'dshs-muted dshs-small' }, message.status),
              ),
              h('div', { className: 'dshs-feed-meta' },
                `${fmtTime(message.sentAt)} · ${message.bytes} B · delivered ${message.deliveredTo?.length ?? 0}`),
            )),
      )
      return h('div', { className: 'dshs-inner' }, boardCard, pheromoneCard, messageCard)
    }

    function Timeline({ data }) {
      const runId = data.swarmId
      const [events, setEvents] = useState([])
      const [cursor, setCursor] = useState(0)
      const [playing, setPlaying] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setEvents([])
        setCursor(0)
        setPlaying(false)
        api(`/runs/${runId}/events?limit=500`, controller.signal)
          .then((payload) => {
            if (!alive) return
            setEvents(payload.events || [])
            setError('')
          })
          .catch((cause) => {
            if (alive && cause?.name !== 'AbortError') setError(String(cause?.message ?? cause))
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [runId])

      useEffect(() => {
        if (!playing) return undefined
        const timer = setInterval(() => {
          setCursor((current) => Math.min(events.length - 1, current + 1))
        }, 700)
        return () => clearInterval(timer)
      }, [playing, events.length])

      useEffect(() => {
        if (playing && events.length > 0 && cursor >= events.length - 1) setPlaying(false)
      }, [playing, cursor, events.length])

      const selected = events[cursor]
      const payloadText = selected ? JSON.stringify(selected.payload, null, 2).slice(0, 4000) : ''
      const move = (delta) => {
        setPlaying(false)
        setCursor((current) => Math.max(0, Math.min(events.length - 1, current + delta)))
      }

      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('h3', { className: 'dshs-section-title' }, translate('timelineTitle')),
          error ? h('div', { className: 'dshs-banner dshs-banner-error' }, `${translate('loadFailed')}: ${error}`) : null,
          h('div', { className: 'dshs-timeline-controls' },
            h('button', {
              className: 'dshs-button',
              type: 'button',
              onClick: () => setPlaying((value) => !value),
            }, playing ? translate('pause') : translate('play')),
            h('button', { className: 'dshs-button', type: 'button', onClick: () => move(-1) }, translate('stepBack')),
            h('button', { className: 'dshs-button', type: 'button', onClick: () => move(1) }, translate('stepForward')),
            h('input', {
              type: 'range',
              min: 0,
              max: Math.max(0, events.length - 1),
              value: Math.min(cursor, Math.max(0, events.length - 1)),
              onChange: (event) => {
                setPlaying(false)
                setCursor(Number(event.target.value))
              },
            }),
            h('span', { className: 'dshs-muted dshs-small' },
              `${events.length === 0 ? 0 : cursor + 1} / ${events.length} ${translate('eventsLoaded')}`),
          ),
          h('div', { className: 'dshs-timeline' },
            h('div', { className: 'dshs-event-list' },
              events.length === 0
                ? h('div', { className: 'dshs-empty' }, translate('noEvents'))
                : events.map((event, index) => h('button', {
                    key: event.seq,
                    type: 'button',
                    className: `dshs-event-item${index === cursor ? ' dshs-event-item-active' : ''}`,
                    onClick: () => {
                      setPlaying(false)
                      setCursor(index)
                    },
                  }, `${event.seq}  ${event.type}  ${fmtTime(event.at)}`)),
            ),
            h('div', { className: 'dshs-event-detail' },
              selected
                ? h('div', null,
                    h('div', { className: 'dshs-section-title' }, `#${selected.seq} ${selected.type}`),
                    h('div', { className: 'dshs-muted dshs-small' }, `${selected.actor} · ${fmtTime(selected.at)}`),
                    h('div', { className: 'dshs-muted dshs-small', style: { marginTop: 6 } }, translate('eventPayload')),
                    h('pre', { className: 'dshs-payload' }, payloadText),
                  )
                : h('div', { className: 'dshs-empty' }, translate('noEvents')),
            ),
          ),
        ),
      )
    }

    function Budget({ data }) {      const budget = data.budget || {}
      const runBudget = budget.run || {}
      const limits = budget.limits || {}
      const tasks = budget.tasks || {}
      const members = budget.members || {}
      const taskTitles = new Map((data.tasks || []).map((task) => [task.id, task.title]))
      const memberNames = new Map((data.members || []).map((member) => [member.id, member.name]))
      const costRows = (map, labelOf) =>
        Object.entries(map)
          .map(([key, ledger]) => ({ key, label: labelOf(key), tokens: ledger.tokens ?? 0 }))
          .filter((row) => row.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 12)
      const taskCost = costRows(tasks, (key) => taskTitles.get(key) || shortId(key))
      const memberCost = costRows(members, (key) => memberNames.get(key) || shortId(key))
      const memberRoles = new Map((data.members || []).map((member) => [member.id, member.role]))
      const roleLedgers = {}
      for (const [memberId, ledger] of Object.entries(members)) {
        const role = memberRoles.get(memberId) || 'unknown'
        roleLedgers[role] = { tokens: (roleLedgers[role]?.tokens ?? 0) + (ledger.tokens ?? 0) }
      }
      const roleCost = costRows(roleLedgers, (role) => role)
      const costTotal = taskCost.reduce((sum, row) => sum + row.tokens, 0) || 1
      const costCard = (label, list) =>
        h('div', { className: 'dshs-card' },
          h('h3', { className: 'dshs-section-title' }, label),
          list.length === 0
            ? h('span', { className: 'dshs-muted dshs-small' }, translate('noCost'))
            : list.map((row) => h('div', { className: 'dshs-cost-row', key: row.key },
                h('div', { className: 'dshs-cost-label', title: row.key }, row.label || row.key),
                h('div', { className: 'dshs-cost-track' },
                  h('div', { className: 'dshs-cost-fill', style: { width: `${Math.max(2, (row.tokens / costTotal) * 100)}%` } })),
                h('div', { className: 'dshs-cost-value' }, `${row.tokens}`),
              )),
        )
      const rows = (map) => Object.entries(map).map(([key, ledger]) => h('tr', { key },
        h('td', null, h('span', { title: key }, shortId(key))),
        h('td', null, ledger.tokens ?? 0),
        h('td', null, ledger.reservedTokens ?? 0),
        h('td', null, ledger.calls ?? 0),
        h('td', null, (ledger.usd ?? 0).toFixed(4)),
      ))
      const table = (label, map) => h('div', { className: 'dshs-card' },
        h('h3', { className: 'dshs-section-title' }, label),
        Object.keys(map).length === 0
          ? h('span', { className: 'dshs-muted dshs-small' }, translate('none'))
          : h('table', { className: 'dshs-table' },
              h('thead', null, h('tr', null,
                h('th', null, translate('scope')),
                h('th', null, translate('tokens')),
                h('th', null, translate('reserved')),
                h('th', null, translate('calls')),
                h('th', null, translate('usd')),
              )),
              h('tbody', null, rows(map)),
            ),
      )
      return h('div', { className: 'dshs-inner' },
        h('div', { className: 'dshs-card' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 } },
            h('h3', { className: 'dshs-section-title', style: { margin: 0 } }, translate('budgetRun')),
            h('a', {
              className: 'dshs-button',
              href: `${API}/runs/${data.swarmId}/report.csv`,
              download: '',
            }, translate('exportCsv')),
          ),
          h(BudgetBar, { used: runBudget.tokens ?? 0, limit: limits.runTokens ?? 0 }),
          h('div', { className: 'dshs-meta-grid', style: { marginTop: 12 } },
            h(Meta, { label: translate('used'), value: `${runBudget.tokens ?? 0} tokens` }),
            h(Meta, { label: translate('reserved'), value: `${runBudget.reservedTokens ?? 0} tokens` }),
            h(Meta, { label: translate('calls'), value: runBudget.calls ?? 0 }),
            h(Meta, { label: translate('usd'), value: (runBudget.usd ?? 0).toFixed(4) }),
            h(Meta, { label: translate('limit'), value: `${limits.runTokens ?? 0} tokens` }),
            h(Meta, { label: translate('wall'), value: `${Math.round((runBudget.wallMs ?? 0) / 1000)}s` }),
          ),
        ),
        table(translate('perTask'), tasks),
        table(translate('perMember'), members),
        costCard(translate('costByTask'), taskCost),
        costCard(translate('costByMember'), memberCost),
        costCard(translate('costByRole'), roleCost),
      )
    }

    function SwarmPage() {
      const [runs, setRuns] = useState([])
      const [runId, setRunId] = useState(null)
      const [data, setData] = useState(null)
      const [tab, setTab] = useState('overview')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [nonce, setNonce] = useState(0)

      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        let busy = false
        async function tick() {
          if (busy) return
          busy = true
          try {
            const list = await api('/runs', controller.signal)
            if (!alive) return
            const nextRuns = list.runs || []
            setRuns(nextRuns)
            let selected = runId
            if (!selected || !nextRuns.some((run) => run.swarmId === selected)) {
              selected = nextRuns[0]?.swarmId ?? null
              if (selected !== runId) setRunId(selected)
            }
            if (selected) {
              const detail = await api(`/runs/${selected}`, controller.signal)
              if (alive) {
                setData(detail)
                setError('')
              }
            } else if (alive) {
              setData(null)
              setError('')
            }
          } catch (cause) {
            if (alive && cause?.name !== 'AbortError') setError(String(cause?.message ?? cause))
          } finally {
            busy = false
            if (alive) setLoading(false)
          }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => {
          alive = false
          clearInterval(timer)
          controller.abort()
        }
      }, [runId, nonce])

      useEffect(() => {
        if (!subscribeLocale) return undefined
        return subscribeLocale(() => setNonce((value) => value + 1))
      }, [])

      const refresh = useCallback(() => {
        setLoading(true)
        setNonce((value) => value + 1)
      }, [])

      const tabs = [
        ['overview', translate('tabOverview')],
        ['members', translate('tabMembers')],
        ['tasks', translate('tabTasks')],
        ['topology', translate('tabTopology')],
        ['hive', translate('tabHive')],
        ['timeline', translate('tabTimeline')],
        ['budget', translate('tabBudget')],
      ]

      return h('div', { className: 'dshs-root' },
        h('style', null, CSS),
        h('div', { className: 'dshs-header' },
          h('div', { className: 'dshs-header-main' },
            h('div', { className: 'dshs-title-wrap' },
              h('div', { className: 'dshs-logo' },
                h('svg', { width: 20, height: 20, viewBox: '0 0 64 64', 'aria-hidden': true },
                  h('path', { d: 'M32 9l18 10.5v21L32 51 14 40.5v-21L32 9z', fill: 'none', stroke: 'currentColor', strokeWidth: 3 }),
                  h('circle', { cx: 32, cy: 20, r: 3, fill: 'currentColor' }),
                  h('circle', { cx: 23, cy: 35.5, r: 3, fill: 'currentColor' }),
                  h('circle', { cx: 41, cy: 35.5, r: 3, fill: 'currentColor' }),
                ),
              ),
              h('div', null,
                h('h1', { className: 'dshs-title' }, translate('title')),
                h('p', { className: 'dshs-subtitle' }, translate('subtitle')),
              ),
            ),
            h('div', { className: 'dshs-actions' },
              runs.length > 0
                ? h('select', {
                    className: 'dshs-select',
                    value: runId || '',
                    onChange: (event) => {
                      setRunId(event.target.value)
                      setData(null)
                    },
                  }, runs.map((run) => h('option', { key: run.swarmId, value: run.swarmId },
                    `${run.swarmId} · ${run.status} · ${run.goal?.slice(0, 32) || ''}`,
                  )))
                : null,
              h('button', { className: 'dshs-button', type: 'button', onClick: refresh }, translate('refresh')),
            ),
          ),
          h('div', { className: 'dshs-tabs' },
            tabs.map(([key, label]) => h('button', {
              key,
              type: 'button',
              className: `dshs-tab${tab === key ? ' dshs-tab-active' : ''}`,
              onClick: () => setTab(key),
            }, label)),
          ),
        ),
        h('div', { className: 'dshs-scroll' },
          error ? h('div', { className: 'dshs-banner dshs-banner-error' }, `${translate('error')}: ${error}`) : null,
          loading && !data
            ? h('div', { className: 'dshs-empty' }, translate('loading'))
            : data
              ? tab === 'members'
                ? h(Members, { data })
                : tab === 'tasks'
                  ? h(Tasks, { data })
                  : tab === 'topology'
                    ? h(Topology, { data })
                    : tab === 'hive'
                      ? h(Hive, { data })
                      : tab === 'timeline'
                        ? h(Timeline, { data })
                      : tab === 'budget'
                        ? h(Budget, { data })
                        : h(Overview, { data })
              : h('div', { className: 'dshs-card dshs-empty' },
                  h('strong', null, translate('noRuns')),
                  h('span', null, translate('noRunsHint')),
                ),
        ),
      )
    }

    function NavIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 64 64', 'aria-hidden': true },
        h('path', { d: 'M32 9l18 10.5v21L32 51 14 40.5v-21L32 9z', fill: 'none', stroke: 'currentColor', strokeWidth: 3 }),
        h('circle', { cx: 32, cy: 20, r: 3, fill: 'currentColor' }),
        h('circle', { cx: 23, cy: 35.5, r: 3, fill: 'currentColor' }),
        h('circle', { cx: 41, cy: 35.5, r: 3, fill: 'currentColor' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))
        translate = ctx.locale.bind(NS)
        subscribeLocale = (listener) => ctx.locale.subscribe(listener)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'swarm',
          order: 30,
          label: () => translate('navLabel'),
        }, NavIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'swarm',
        }, SwarmPage))
      },
    }
  },
})
