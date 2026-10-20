/**
 * Browser half: two small dials pinned to the sidebar foot, directly above the
 * account / settings row — account balance on the left, live output speed on
 * the right.
 *
 * The balance comes from the account Remote the shell already mounts
 * (`ctx.remote.account.getBalance`), so this plugin reads no files, holds no
 * API key, and talks to no new endpoint.
 *
 * The speed is total traffic: the Node half of this plugin counts every
 * streamed delta the Host emits (every session, every subagent) and answers
 * `GET /balance-gauge/traffic` with a sliding-window rate. This half just polls
 * it — no per-session statistics, so nothing can jump when sessions switch.
 *
 * Both needles are driven by one damped-spring animation loop rather than CSS
 * transitions: data changes only move the target, the needle glides there with
 * mass, like a real instrument.
 */

/** Automatic re-read interval once a reading succeeds. */
const REFRESH_MS = 60000

/** Retry ladder while reading the balance fails. */
const RETRY_DELAYS = [1500, 4000, 10000, 30000]

/** Traffic poll period. */
const SAMPLE_MS = 300

/** Where the Node half publishes the global rate. */
const TRAFFIC_ROUTE = '/balance-gauge/traffic'

/** Above this the gauge counts as "generating" (and trembles). */
const LIVE_FLOOR = 0.5

/** Needle spring: stiff enough to track, damped enough not to wobble. */
const NEEDLE_STIFFNESS = 120
const NEEDLE_DAMPING = 19
const NEEDLE_EPSILON = 0.0005

/**
 * Live tremor, the way a dashboard needle shakes with the engine: two
 * incommensurate sines so it does not read as a clean oscillation. It only runs
 * while tokens are actually flowing, so an idle gauge is still.
 */
const TREMOR_MAX_DEG = 4
const TREMOR_HZ = 11.5
const TREMOR_HZ_SLOW = 4.7
const TREMOR_GAIN = 3.2

/** The version literal the account Remote expects; the boot graph carries it. */
const FALLBACK_CLIENT_VERSION = '0.2.1-rc.2'

/* ------------------------------------------------------------------ needles */

/** One entry per dial: where it points now, where it is heading, its momentum. */
const needleRig = {
  money: { target: 0, position: 0, velocity: 0, element: null, phase: 0, trembles: false, live: false },
  speed: { target: 0, position: 0, velocity: 0, element: null, phase: 0, trembles: true, live: false },
}

/** The one animation loop, started on first needle mount. */
let needleAnimation = null

/** Write the current position (plus any tremor) onto the needle's transform. */
function paintNeedle(state, offset) {
  if (state.element === null) return
  const degrees = state.position * 180 - 90 + (offset || 0)
  state.element.style.transform = `rotate(${degrees.toFixed(2)}deg)`
}

/** Integrate one frame of the spring for both needles. */
function stepNeedles() {
  const now = performance.now()
  const dt = Math.min(0.05, Math.max(0.001, (now - needleAnimation.last) / 1000))
  needleAnimation.last = now
  for (const key of ['money', 'speed']) {
    const state = needleRig[key]
    if (state.element === null) {
      state.position = state.target
      state.velocity = 0
      continue
    }
    if (needleAnimation.still) {
      state.position = state.target
      state.velocity = 0
      paintNeedle(state, 0)
      continue
    }
    const before = state.position
    const delta = state.target - state.position
    state.velocity += delta * NEEDLE_STIFFNESS * dt
    state.velocity *= Math.exp(-NEEDLE_DAMPING * dt)
    state.position += state.velocity * dt
    if (Math.abs(delta) < NEEDLE_EPSILON && Math.abs(state.velocity) < NEEDLE_EPSILON) {
      state.position = state.target
      state.velocity = 0
    }
    // Live tremor: strongest at full scale, gone at zero, and only while tokens
    // are flowing, so an idle gauge stays perfectly still.
    let tremor = 0
    if (state.trembles && state.live) {
      const amplitude = TREMOR_MAX_DEG * Math.min(1, Math.max(0, state.target) * TREMOR_GAIN)
      if (amplitude > 0.01) {
        state.phase = (state.phase + dt) % 1000
        tremor =
          amplitude *
          (Math.sin(state.phase * TREMOR_HZ * 2 * Math.PI) * 0.62 +
            Math.sin(state.phase * TREMOR_HZ_SLOW * 2 * Math.PI + 1.7) * 0.38)
      }
    }
    // A still needle writes nothing: the loop idles until a target or the
    // tremor moves it.
    if (state.position !== before || tremor !== 0) paintNeedle(state, tremor)
  }
  needleAnimation.frame = requestAnimationFrame(stepNeedles)
}

/** Idempotent start of the animation loop. */
function ensureNeedleAnimation() {
  if (needleAnimation !== null) return
  let still = false
  try {
    still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (error) {
    still = false
  }
  needleAnimation = { last: performance.now(), frame: 0, still: still }
  needleAnimation.frame = requestAnimationFrame(stepNeedles)
}

/** Callback ref for one dial's needle group. */
function attachNeedle(key) {
  return (element) => {
    if (element === null) return
    const state = needleRig[key]
    state.element = element
    ensureNeedleAnimation()
    paintNeedle(state, 0)
  }
}

/** The SVG for one dial: rendered tracks plus a React-owned, animated needle. */
function dialElement(options) {
  const dim = !!options.dim
  const needle = dim
    ? null
    : React.createElement(
        'g',
        { className: 'bg-needle', ref: attachNeedle(options.key) },
        React.createElement('circle', {
          cx: 60,
          cy: 60,
          r: NEEDLE.glowRadius,
          className: 'bg-glow',
          fill: options.tint,
          opacity: 0.14,
        }),
        React.createElement('polygon', { className: 'bg-blade', points: NEEDLE.blade }),
        React.createElement('circle', { cx: 60, cy: 60, r: NEEDLE.hubRadius, className: 'bg-hub' }),
        React.createElement('circle', { cx: 60, cy: 60, r: NEEDLE.dotRadius, className: 'bg-hub-dot' }),
      )
  return React.createElement(
    'svg',
    { className: 'bg-dial', viewBox: '0 0 120 68', role: 'img', 'aria-label': options.label },
    React.createElement('g', { dangerouslySetInnerHTML: { __html: options.tracks } }),
    needle,
  )
}

/* --------------------------------------------------------------- data reads */

/** Read the Host release version out of the boot payload, if it is there. */
function readClientVersion() {
  try {
    const boot = globalThis.__DSH_BOOT__
    const release = boot && boot.release
    const manifestRelease = boot && boot.manifest && boot.manifest.release
    const version = (release && release.version) || (manifestRelease && manifestRelease.version) || (boot && boot.version)
    if (typeof version === 'string' && version.length > 0) return version
  } catch (error) {
    /* boot payload absent: fall through to the literal */
  }
  return FALLBACK_CLIENT_VERSION
}

/** Read the active UI language, defaulting to Chinese. */
function readLocale(ctx) {
  try {
    const snapshot = ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined
    const active = snapshot && snapshot.active
    if (typeof active === 'string' && active.length > 0) return active
  } catch (error) {
    /* locale service absent */
  }
  return 'zh-CN'
}

/** The account Remote, however the shell happens to expose the namespace. */
function accountRemote(ctx) {
  try {
    const direct = ctx.remote && ctx.remote.account
    if (direct && typeof direct.getBalance === 'function') return direct
  } catch (error) {
    /* fall through to the named lookup */
  }
  try {
    if (typeof ctx.get === 'function') {
      const named = ctx.get('remote.account')
      if (named && typeof named.getBalance === 'function') return named
      const parent = ctx.get('remote')
      const nested = parent && parent.account
      if (nested && typeof nested.getBalance === 'function') return nested
    }
  } catch (error) {
    /* not registered under that name either */
  }
  return undefined
}

/** The amount of one wallet: the platform's `balance` field, `amount` as a fallback. */
function walletAmount(wallet) {
  if (!wallet) return undefined
  const value = wallet.balance !== undefined ? wallet.balance : wallet.amount
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

/** Every wallet the account Remote returned, recharge and bonus alike. */
function readWallets(outcome) {
  const normal = Array.isArray(outcome && outcome.value) ? outcome.value : []
  const bonus = Array.isArray(outcome && outcome.bonusWallets) ? outcome.bonusWallets : []
  return normal.concat(bonus).filter((wallet) => walletAmount(wallet) !== undefined)
}

/** Sum the wallets of one currency. */
function totalOf(wallets, currency) {
  let total = 0
  for (const wallet of wallets) {
    if (wallet.currency !== currency) continue
    const value = Number(walletAmount(wallet))
    if (Number.isFinite(value)) total += value
  }
  return total
}

/** Pick the currency to display: CNY when present, else the first wallet's. */
function pickBalance(outcome) {
  const wallets = readWallets(outcome)
  if (wallets.length === 0) return undefined
  const currencies = []
  for (const wallet of wallets) {
    if (typeof wallet.currency === 'string' && currencies.indexOf(wallet.currency) === -1) currencies.push(wallet.currency)
  }
  const currency = currencies.indexOf('CNY') === -1 ? currencies[0] : 'CNY'
  if (typeof currency !== 'string') return undefined
  return { currency: currency, total: totalOf(wallets, currency) }
}

/** Build the sidebar entry bound to one client context. */
function createGauge(ctx) {
  return function BalanceGauge(props) {
    const [nonce, setNonce] = React.useState(0)
    const [view, setView] = React.useState({ phase: 'loading' })
    const [speed, setSpeed] = React.useState(0)
    const [live, setLive] = React.useState(false)
    const [trafficReady, setTrafficReady] = React.useState(false)

    // The collapsed rail is 56px wide: no room for a dial, and the account row
    // it sits above is an icon there too.
    const wide = !props || props.wide !== false

    React.useEffect(() => {
      if (!wide) return undefined
      let cancelled = false
      let timer
      let attempt = 0

      const settle = (delay) => {
        if (!cancelled) timer = setTimeout(load, delay)
      }

      const load = async () => {
        let next
        try {
          const account = accountRemote(ctx)
          if (account === undefined) {
            next = { phase: 'failed', reason: 'service' }
          } else {
            const result = await account.getBalance({
              version: readClientVersion(),
              locale: readLocale(ctx),
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            })
            if (cancelled) return
            if (!result || result.ok !== true) {
              next = { phase: 'failed', reason: (result && result.error && result.error.code) || 'rpc' }
            } else {
              const outcome = result.value
              if (!outcome || outcome.status !== 'ready') {
                next = { phase: 'unavailable', reason: (outcome && outcome.status) || 'unknown' }
              } else {
                const picked = pickBalance(outcome)
                next =
                  picked === undefined
                    ? { phase: 'failed', reason: 'shape' }
                    : { phase: 'ready', balance: picked.total, currency: picked.currency, at: Date.now() }
              }
            }
          }
        } catch (error) {
          if (cancelled) return
          next = { phase: 'failed', reason: (error && error.message) || 'error' }
        }
        if (cancelled) return
        setView(next)
        if (next.phase === 'ready') {
          attempt = 0
          settle(REFRESH_MS)
        } else {
          console.warn('[dsh-balance-gauge]', next.phase, next.reason)
          settle(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
          attempt += 1
        }
      }

      load()
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }, [nonce, wide])

    // Total traffic: the Host's sliding-window rate over every streamed delta.
    // It already decays on its own when the stream stops, so there is nothing
    // to average and nothing to unwind here.
    React.useEffect(() => {
      if (!wide) return undefined
      let cancelled = false
      const tick = async () => {
        try {
          const response = await fetch(TRAFFIC_ROUTE, { cache: 'no-store' })
          if (!response.ok) throw new Error(`http ${response.status}`)
          const payload = await response.json()
          if (cancelled) return
          const value = Number(payload && payload.tokensPerSecond)
          const rate = Number.isFinite(value) && value > 0 ? value : 0
          setSpeed(rate)
          setLive(rate > LIVE_FLOOR)
          setTrafficReady(true)
          needleRig.speed.live = rate > LIVE_FLOOR
        } catch (error) {
          if (cancelled) return
          setSpeed(0)
          setLive(false)
          setTrafficReady(false)
          needleRig.speed.live = false
        }
      }
      tick()
      const timer = setInterval(tick, SAMPLE_MS)
      return () => {
        cancelled = true
        clearInterval(timer)
        needleRig.speed.live = false
      }
    }, [wide])

    const ready = view.phase === 'ready'
    const zone = ready ? zoneOf(view.balance) : 'unknown'
    const percent = ready ? percentOf(view.balance) : 0
    const speedPercentValue = speedPercent(speed)

    // Data changes only move the target; the loop does the travelling.
    React.useEffect(() => {
      needleRig.money.target = percent
    }, [percent])
    React.useEffect(() => {
      needleRig.speed.target = speedPercentValue
    }, [speedPercentValue])

    if (!wide) return null

    const copy = COPY[ready ? zone : view.phase] || COPY.loading
    const amount = ready ? formatMoney(view.balance, view.currency) : view.phase === 'loading' ? '···' : '--'
    const reason = view.reason === undefined ? '' : String(view.reason).slice(0, 12)
    const subText = ready || reason === '' ? `${copy.emoji} ${copy.text}` : `${copy.emoji} ${copy.text} · ${reason}`
    const hint = ready
      ? `${formatMoney(view.balance, view.currency)} · 满格 ¥${FULL_SCALE} · 单击刷新`
      : view.phase === 'loading'
        ? '正在读取账户余额'
        : `${copy.text}${reason === '' ? '' : `（${reason}）`} · 单击重试`

    const speedHint = !trafficReady
      ? '读不到全进程流量（宿主路由 /balance-gauge/traffic 未响应，可能还没重启）'
      : live
        ? `正在输出 ${formatSpeed(speed)} tok/s · 全进程实时流量（含子代理），满格 ${SPEED_MAX}`
        : `空闲 · 全进程实时流量已经在回落，满格 ${SPEED_MAX}`

    const refresh = () => setNonce((current) => current + 1)

    return React.createElement(
      'div',
      { className: 'bg-root' },
      React.createElement(
        'div',
        {
          className: 'bg-card',
          'data-zone': zone,
          'data-phase': view.phase,
          role: 'button',
          tabIndex: 0,
          title: `${hint}\n${speedHint}`,
          // Zone tints travel as custom properties so the arcs (SVG, built in
          // gauge.js) and the amount ink (CSS) share one palette.
          style: { '--bg-zone': ZONE_COLORS[zone] || ZONE_COLORS.unknown, '--bg-zone-ink': ZONE_INK[zone] || '' },
          onClick: refresh,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              refresh()
            }
          },
        },
        React.createElement(
          'span',
          { className: 'bg-cell' },
          React.createElement(
            'span',
            { className: 'bg-dial-host' },
            dialElement({
              key: 'money',
              tracks: dialTracks({ zone: zone, dim: !ready }),
              tint: ZONE_COLORS[zone] || ZONE_COLORS.unknown,
              label: `余额油量 ${Math.round(percent * 100)}%`,
              dim: !ready,
            }),
          ),
          React.createElement(
            'span',
            { className: 'bg-readout' },
            React.createElement('span', { className: 'bg-amount bg-amount--money' }, amount),
            React.createElement('span', { className: 'bg-sub' }, subText),
          ),
        ),
        React.createElement('span', { className: 'bg-divider' }),
        React.createElement(
          'span',
          { className: 'bg-cell' },
          React.createElement(
            'span',
            { className: 'bg-dial-host' },
            dialElement({
              key: 'speed',
              tracks: speedTracks({ percent: speedPercentValue, dim: !trafficReady }),
              tint: '#4D6BFE',
              label: `输出速度 ${Math.round(speedPercentValue * 100)}%`,
              dim: !trafficReady,
            }),
          ),
          React.createElement(
            'span',
            { className: 'bg-readout' },
            React.createElement('span', { className: 'bg-amount bg-amount--speed' }, formatSpeed(speed)),
            React.createElement('span', { className: 'bg-sub' }, 'tok/s'),
          ),
        ),
      ),
    )
  }
}

/** Services the sidebar registration needs. */
const inject = ['slots', 'remote', 'locale']

/** Client plugin body: register the twin gauges above the account row. */
function apply(ctx) {
  const BalanceGauge = createGauge(ctx)
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'balance-gauge',
        order: 100,
        label: '余额与速度表',
        registrant: 'dsh-balance-gauge',
      },
      BalanceGauge,
    ),
  )
}
