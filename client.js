/**
 * Browser half of `dsh-provider-commandcode`.
 *
 * A quota pill in the composer dock, shown while the session's selected model
 * belongs to the `commandcode` route. The host reads the account (the browser
 * never holds the API key) and answers `commandcode/usage`; this half polls it,
 * renders the 5-hour, weekly, and monthly windows, and offers one manual
 * refresh.
 *
 * The artifact is the client module system's lazy-CJS factory format: running
 * it only registers a factory, and the imports and side effects below run when
 * the plugin is first materialized.
 */
window.__ModuleLoader__.load({
  id: 'dsh-provider-commandcode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'commandcode'
    /** Provider route id the quota belongs to. */
    const PROVIDER_ID = 'commandcode'
    /** Host Remote namespace carrying the quota reading. */
    const RPC_NAMESPACE = 'commandcode'
    /** How often the pill refreshes its reading while it is visible. */
    const POLL_MS = 60_000

    const zh = {
      'quota.label': '额度',
      'quota.none': '额度 ?',
      'quota.title': 'Command Code 额度',
      'quota.plan': '套餐 {plan}',
      'quota.fiveHour': '5 小时',
      'quota.weekly': '本周',
      'quota.monthly': '本月',
      'quota.used': '已用 {used} / {limit}',
      'quota.left': '剩余 {left}',
      'quota.resets': '{when}后重置',
      'quota.renews': '{when}后续期',
      'quota.extra': '充值 {purchased} · 赠送 {free}',
      'quota.updated': '更新于 {time}',
      'quota.refresh': '刷新',
      'quota.refreshing': '刷新中…',
      'quota.failed': '读取失败：{message}',
      'quota.exhausted': '已用尽一个窗口',
      'quota.unavailable': '额度不可用',
      'quota.noHost': '浏览器连接不可用',
      'quota.minutes': '{minutes} 分钟',
      'quota.hours': '{hours} 小时 {minutes} 分',
      'quota.days': '{days} 天 {hours} 小时',
      'quota.aria': 'Command Code 额度：{summary}',
    }

    const en = {
      'quota.label': 'Quota',
      'quota.none': 'Quota ?',
      'quota.title': 'Command Code quota',
      'quota.plan': 'Plan {plan}',
      'quota.fiveHour': '5 hours',
      'quota.weekly': 'Weekly',
      'quota.monthly': 'Monthly',
      'quota.used': '{used} / {limit} used',
      'quota.left': '{left} left',
      'quota.resets': 'resets in {when}',
      'quota.renews': 'renews in {when}',
      'quota.extra': '{purchased} bought · {free} granted',
      'quota.updated': 'Updated {time}',
      'quota.refresh': 'Refresh',
      'quota.refreshing': 'Refreshing…',
      'quota.failed': 'Could not read the quota: {message}',
      'quota.exhausted': 'A window is exhausted',
      'quota.unavailable': 'Quota unavailable',
      'quota.noHost': 'The browser connection is unavailable',
      'quota.minutes': '{minutes} min',
      'quota.hours': '{hours} h {minutes} min',
      'quota.days': '{days} d {hours} h',
      'quota.aria': 'Command Code quota: {summary}',
    }

    /** Stable fallback for slot contexts that expose no session projection seat. */
    const noProjection = () => undefined

    function detail(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    /** Boundary percentage for the compact pill and the panel value. */
    function percent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(Math.min(100, Math.max(0, value)))}%`
    }

    /** One amount in the reading's own unit: bought dollars carry `$`, plan credits do not. */
    function amount(value, unit) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2)
      return unit === 'usd' ? `$${rounded}` : rounded
    }

    /** Time before a reset, in the coarsest useful unit. */
    function countdown(at, t, now) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
      const minutes = Math.max(0, Math.ceil((at - now) / 60_000))
      if (minutes < 60) return t('quota.minutes', { minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('quota.hours', { hours, minutes: minutes % 60 })
      return t('quota.days', { days: Math.floor(hours / 24), hours: hours % 24 })
    }

    /** Local clock time of the reading that fed the panel. */
    function clock(epoch) {
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return '—'
      const date = new Date(epoch)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }

    /** Color ramp for a used share: normal, warning from 75%, error from 90%. */
    function tint(value) {
      if (value >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (value >= 75) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-business-primary)'
    }

    /** The three descending bars the pill and the panel share. */
    function QuotaIcon() {
      return h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true }, [
        h('rect', { key: 'a', x: 1, y: 2.4, width: 12, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.9 }),
        h('rect', { key: 'b', x: 1, y: 5.9, width: 8, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.65 }),
        h('rect', { key: 'c', x: 1, y: 9.4, width: 4.5, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.4 }),
      ])
    }

    /** One row per window the plan enforces, plus the month's credits. */
    function rowsOf(data, t, now) {
      const unit = data?.unit === 'usd' ? 'usd' : 'credits'
      const rows = []
      const addWindow = (key, label, entry) => {
        if (entry === undefined || entry === null || typeof entry.percent !== 'number') return
        const note = []
        if (typeof entry.limit === 'number') note.push(t('quota.left', { left: amount(entry.limit - entry.used, unit) }))
        const reset = countdown(entry.resetsAt, t, now)
        if (reset !== undefined) note.push(t('quota.resets', { when: reset }))
        rows.push({
          key,
          label,
          percent: entry.percent,
          used: t('quota.used', { used: amount(entry.used, unit), limit: amount(entry.limit, unit) }),
          note: note.join(' · '),
        })
      }
      addWindow('fiveHour', t('quota.fiveHour'), data?.windows?.fiveHour)
      addWindow('weekly', t('quota.weekly'), data?.windows?.weekly)
      const monthly = data?.monthly
      if (monthly !== undefined && monthly !== null && typeof monthly.percent === 'number') {
        const note = [t('quota.left', { left: amount(monthly.remaining, unit) })]
        const renew = countdown(monthly.renewsAt, t, now)
        if (renew !== undefined) note.push(t('quota.renews', { when: renew }))
        const purchased = data?.balance?.purchased ?? 0
        const free = data?.balance?.free ?? 0
        if (purchased + free > 0) note.push(t('quota.extra', { purchased: amount(purchased, unit), free: amount(free, unit) }))
        rows.push({
          key: 'monthly',
          label: t('quota.monthly'),
          percent: monthly.percent,
          used: t('quota.used', { used: amount(monthly.used, unit), limit: amount(monthly.limit, unit) }),
          note: note.join(' · '),
        })
      }
      return rows
    }

    /** The one-line reading the pill shows and its accessible name repeats. */
    function summaryOf(rows, t) {
      if (rows.length === 0) return t('quota.none')
      return rows.slice(0, 2).map((row) => `${row.label} ${percent(row.percent)}`).join(' · ')
    }

    /**
     * Quota pill pinned in the composer dock. It renders only while the
     * session's selected provider is Command Code, polls once a minute, and
     * refreshes when the page becomes visible again.
     * @param props - injected copy and quota call, plus the session kit's projection seat.
     */
    function QuotaPill({ t, fetchQuota, useProjection }) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [open, setOpen] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const root = React.useRef(null)
      const alive = React.useRef(true)
      const ticket = React.useRef(0)
      const project = typeof useProjection === 'function' ? useProjection : noProjection
      const selection = project('modelSelection')
      const active = selection?.next?.provider === PROVIDER_ID

      const load = React.useCallback(async (force) => {
        const current = ++ticket.current
        try {
          const answer = await fetchQuota(force === true)
          if (!alive.current || current !== ticket.current) return
          if (answer !== undefined && answer !== null && answer.configured === false) {
            setState({ phase: 'empty' })
            return
          }
          if (answer === undefined || answer === null || typeof answer !== 'object') {
            setState({ phase: 'error', error: 'empty response' })
            return
          }
          setState({ phase: 'ready', data: answer })
        } catch (cause) {
          if (!alive.current || current !== ticket.current) return
          setState({ phase: 'error', error: detail(cause) })
        }
      }, [fetchQuota])

      React.useEffect(() => {
        if (active) return
        if (open) setOpen(false)
        if (refreshing) setRefreshing(false)
      }, [active, open, refreshing])

      React.useEffect(() => {
        if (!active) return undefined
        alive.current = true
        void load(false)
        const timer = setInterval(() => { void load(true) }, POLL_MS)
        const visible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load(true)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible)
        return () => {
          alive.current = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible)
        }
      }, [active, load])

      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const outside = (event) => {
          if (root.current !== null && !root.current.contains(event.target)) setOpen(false)
        }
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('pointerdown', outside)
          document.removeEventListener('keydown', escape)
        }
      }, [open])

      if (!active || state.phase === 'empty') return null

      const refreshing_now = refreshing
      const refresh = async () => {
        if (refreshing_now) return
        setRefreshing(true)
        try {
          await load(true)
        } finally {
          if (alive.current) setRefreshing(false)
        }
      }

      const ready = state.phase === 'ready'
      const now = ready ? Date.now() : 0
      const rows = ready ? rowsOf(state.data, t, now) : []
      const summary = ready ? summaryOf(rows, t) : state.phase === 'error' ? t('quota.unavailable') : t('quota.none')

      const panel = !open ? null : h('div', {
        role: 'dialog',
        'aria-label': t('quota.title'),
        style: {
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1100,
          boxSizing: 'border-box',
          width: 264,
          maxWidth: 'calc(100vw - 24px)',
          padding: 12,
          borderRadius: 'var(--dsw-radius-lg)',
          background: 'var(--dsw-specific-menu)',
          boxShadow: 'var(--dsw-elevation-prominent)',
          color: 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
          h(QuotaIcon, { key: 'icon' }),
          h('span', { key: 'title', style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } }, t('quota.title')),
          ready && state.data?.plan?.name !== undefined
            ? h('span', { key: 'plan', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)' } },
              t('quota.plan', { plan: state.data.plan.name }))
            : null,
        ]),
        ready && state.data?.exceeded === true
          ? h('div', { key: 'exhausted', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } },
            t('quota.exhausted'))
          : null,
        ready && rows.length === 0
          ? h('div', { key: 'none', style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } },
            t('quota.none'))
          : null,
        ...rows.map((row) => h('div', { key: row.key, style: { marginTop: 10 } }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } }, [
            h('span', { key: 'label' }, row.label),
            h('span', { key: 'value', style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } }, percent(row.percent)),
          ]),
          h('div', {
            key: 'bar',
            style: { height: 4, margin: '6px 0 4px', borderRadius: 999, background: 'var(--dsw-alias-interactive-bg-hover)', overflow: 'hidden' },
          }, h('div', { style: { width: `${Math.min(100, Math.max(0, row.percent))}%`, height: '100%', background: tint(row.percent) } })),
          h('div', { key: 'used', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' } }, row.used),
          row.note.length === 0 ? null : h('div', {
            key: 'note', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' },
          }, row.note),
        ])),
        h('div', {
          key: 'foot',
          style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
        }, [
          ready
            ? h('span', { key: 'updated', style: { flex: '1 1 auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } },
              t('quota.updated', { time: clock(state.data?.fetchedAt) }))
            : h('span', { key: 'error', role: 'alert', style: { flex: '1 1 auto', color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } },
              t('quota.failed', { message: state.error })),
          h('button', {
            key: 'refresh',
            type: 'button',
            disabled: refreshing_now,
            onClick: () => { void refresh() },
            style: {
              boxSizing: 'border-box',
              height: 24,
              padding: '0 10px',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              borderRadius: 'var(--dsw-radius-md)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              cursor: refreshing_now ? 'default' : 'pointer',
            },
          }, refreshing_now ? t('quota.refreshing') : t('quota.refresh')),
        ]),
      ])

      return h('div', { ref: root, style: { position: 'relative', display: 'flex', alignItems: 'center' } }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          'aria-label': t('quota.aria', { summary }),
          'aria-expanded': open,
          onClick: () => setOpen(!open),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '1px 8px',
            border: 'none',
            borderRadius: 'var(--dsw-radius-md)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        }, [h(QuotaIcon, { key: 'icon' }), h('span', { key: 'label' }, summary)]),
        panel,
      ])
    }

    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-provider-commandcode: copy dictionaries')
      const t = ctx.locale.bind(NS)

      /**
       * Ask the host half for one quota reading. Only the host holds the API
       * key, so the browser never talks to Command Code itself.
       * @param force - bypass the host's short-lived credit cache.
       * @returns the host snapshot, including `configured: false` with no key.
       */
      const fetchQuota = async (force) => {
        const rpc = ctx.get('connection')?.rpc
        if (rpc === undefined || typeof rpc.call !== 'function') throw new Error(t('quota.noHost'))
        const response = await rpc.call('/api', `${RPC_NAMESPACE}/usage`, { args: { force: force === true } })
        if (response?.ok !== true) {
          const failure = response?.error
          throw new Error(typeof failure === 'string' ? failure : failure?.message ?? t('quota.noHost'))
        }
        return response.value
      }

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'commandcode-quota',
        order: 2,
        locale: NS,
        inject: () => ({ t, fetchQuota }),
      }, QuotaPill))
    }

    return { inject, apply }
  },
})
