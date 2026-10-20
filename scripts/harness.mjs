/**
 * Integration harness (dev only, not shipped).
 *
 * Loads the BUILT lib/client.js in a real browser, hands it a stub React and a
 * stub client Context, renders every slot entry it registers, and feeds the
 * hidden bridge a growing `sessionStats` value so the speedometer has something
 * to sample. This exercises the actual factory, both registrations, the balance
 * parsing, the speed sampling and the markup.
 *
 *   node scripts/harness.mjs && open preview/harness-index.html
 *   ?probe=1  → prints a JSON result into <pre id="result">
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

const runner = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<title>balance-gauge harness</title>
<style>
  body { margin: 0; padding: 14px 16px; background: #f6f7f9; font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  #root { width: 280px; }
  .mount { margin-bottom: 6px; }
  #log { font: 11px/1.5 Consolas, monospace; color: #666; white-space: pre-wrap; }
  #result { font: 11px/1.5 Consolas, monospace; color: #1f2329; white-space: pre-wrap; }
</style>
<body>
<div id="root"></div>
<div id="log">booting…</div>
<script>
const params = new URLSearchParams(location.search)
const amount = params.get('amount') ?? '88.5'
const logEl = document.getElementById('log')
const logs = []
function log(message, bad) {
  logs.push((bad ? '✗ ' : '· ') + message)
  logEl.textContent = logs.join('\\n')
  logEl.className = bad ? 'bad' : 'ok'
  if (bad) console.error(message)
}

/* ---- the smallest React this component needs ---------------------------- */
let store = null
function createStore() {
  return { cells: [], effects: [], index: 0, pendingEffects: [] }
}
function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

const ReactStub = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    return { type, props: Object.assign({}, props, { children: flat }) }
  },
  useState(initial) {
    const owner = store
    const index = owner.index++
    if (!(index in owner.cells)) owner.cells[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(owner.cells[index]) : next
      if (Object.is(value, owner.cells[index])) return
      owner.cells[index] = value
      scheduleRender()
    }
    return [owner.cells[index], set]
  },
  useEffect(fn, deps) {
    const owner = store
    const index = owner.index++
    const previous = owner.effects[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) {
      owner.effects[index] = { fn, deps }
      owner.pendingEffects.push(fn)
    }
  },
}

/* ---- render the element tree into real DOM ------------------------------ */
const SKIP_PROPS = new Set(['children', 'dangerouslySetInnerHTML'])
function mount(node, parent) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    parent.appendChild(document.createTextNode(String(node)))
    return
  }
  const el = document.createElement(node.type)
  if (node.props && typeof node.props.ref === 'function') node.props.ref(el)
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (SKIP_PROPS.has(key)) continue
    if (key === 'ref') continue
    if (typeof value === 'function') {
      if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value)
      continue
    }
    if (key === 'className') el.setAttribute('class', value)
    else if (key === 'style' && value && typeof value === 'object') {
      for (const [name, cssValue] of Object.entries(value)) {
        if (name.startsWith('--')) el.style.setProperty(name, String(cssValue))
        else el.style[name] = cssValue
      }
    } else if (key === 'tabIndex') el.setAttribute('tabindex', String(value))
    else if (value !== undefined && value !== null) el.setAttribute(key, String(value))
  }
  if (node.props && node.props.dangerouslySetInnerHTML) el.innerHTML = node.props.dangerouslySetInnerHTML.__html
  for (const child of node.props?.children ?? []) mount(child, el)
  parent.appendChild(el)
}

/* ---- the stub Context --------------------------------------------------- */
// Headless virtual time does not tick the compositor, so drive the needle
// animation loop from timers instead. Only the harness does this.
if (typeof requestAnimationFrame !== 'function' || params.get('realraf') !== '1') {
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16)
}

// Start from a clean per-session table so runs cannot inherit each other.
try {
  localStorage.removeItem('dsh-balance-gauge/sessions')
} catch (error) {
  /* storage unavailable */
}

const startedAt = Date.now()

/** The Node half's route, stubbed: ?rate=0 simulates an idle stream. */
const trafficRate = Number(params.get('rate') ?? 120)
window.fetch = async (url) => {
  if (String(url).indexOf('/balance-gauge/traffic') === -1) throw new Error('unexpected fetch ' + url)
  return {
    ok: true,
    status: 200,
    json: async () => ({ tokensPerSecond: trafficRate, windowMs: 3500, at: Date.now() }),
  }
}

const PAYLOADS = {
  fail: () => ({ ok: false, error: { code: 'unavailable' } }),
  signedout: () => ({ ok: true, value: { status: 'unavailable' } }),
  empty: () => ({ ok: true, value: { status: 'ready', value: [], bonusWallets: [] } }),
  normal: () => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: amount }],
      bonusWallets: [{ currency: 'CNY', balance: '2.00' }],
    },
  }),
}

const ctx = {
  locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
  remote: {
    account: {
      async getBalance(metadata) {
        log('getBalance(' + JSON.stringify(metadata) + ')')
        if (!metadata.version) throw new Error('missing version')
        const build = PAYLOADS[amount] ?? PAYLOADS.normal
        return build()
      },
    },
  },
  slots: {
    inject(name, callback) {
      log('slots.inject(' + name + ')')
      callback()
    },
    register(spec, Component) {
      log('slots.register(' + spec.name + ' id=' + spec.id + ')')
      registered.push({ spec, Component, store: createStore() })
      paint()
    },
  },
}

/* ---- paint every registered entry, each with its own hook store ---------- */
const registered = []
let queued = false
function paint() {
  const container = document.getElementById('root')
  container.textContent = ''
  for (const entry of registered) {
    store = entry.store
    store.index = 0
    store.pendingEffects = []
    const host = document.createElement('div')
    host.className = 'mount'
    host.dataset.entry = String(entry.spec.id)
    container.appendChild(host)
    let element
    try {
      element = entry.Component({ wide: true })
    } catch (error) {
      log('component threw: ' + error.message, true)
      continue
    }
    mount(element, host)
    const effects = store.pendingEffects
    store.pendingEffects = []
    for (const effect of effects) {
      try {
        effect()
      } catch (error) {
        log('effect threw: ' + error.message, true)
      }
    }
  }
}

function scheduleRender() {
  if (queued) return
  queued = true
  setTimeout(() => {
    queued = false
    paint()
  }, 0)
}

// Repaint on a timer so the bridge re-reads the stub projection and publishes
// a growing token count, the way a live session would.
setInterval(paint, 400)

/* ---- load and run the real bundle -------------------------------------- */
window.__ModuleLoader__ = {
  load(record) {
    log('module loader: ' + record.id)
    let mod
    try {
      mod = record.factory((name) => {
        if (name === 'react') return ReactStub
        throw new Error('unexpected require: ' + name)
      })
    } catch (error) {
      log('factory threw: ' + error.message, true)
      return
    }
    log('exports: ' + Object.keys(mod).join(', '))
    log('inject: ' + JSON.stringify(mod.inject))
    try {
      mod.apply(ctx)
    } catch (error) {
      log('apply threw: ' + error.message, true)
    }
  },
}
</script>
<script>${bundle}</script>
<script>
  if (params.get('probe') === '1') {
    const output = document.createElement('pre')
    output.id = 'result'
    output.textContent = 'probe pending'
    document.body.appendChild(output)
    const calls = () => logs.filter((line) => line.indexOf('getBalance(') !== -1).length
    const needles = () =>
      Array.from(document.querySelectorAll('.bg-needle')).map((node) => node.style.transform || '(unset)')
    setTimeout(() => {
      const money = document.querySelector('.bg-amount--money')
      const speed = document.querySelector('.bg-amount--speed')
      const card = document.querySelector('.bg-card')
      const before = calls()
      const needlesBefore = needles()
      if (params.get('click') === '1' && card) card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      setTimeout(() => {
        output.textContent = 'probe ' + JSON.stringify({
          money: money ? money.textContent : null,
          speed: speed ? speed.textContent : null,
          zone: card ? card.getAttribute('data-zone') : null,
          phase: card ? card.getAttribute('data-phase') : null,
          entries: registered.map((entry) => entry.spec.id),
          callsBefore: before,
          callsAfter: calls(),
          needlesBefore: needlesBefore,
          needlesAfter: needles(),
        })
      }, 600)
    }, Number(params.get('probeAt') || 2200))
  }
</script>
</body>
</html>
`

const index = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<title>balance-gauge harness</title>
<style>
  body { margin: 0; padding: 14px; background: #f6f7f9; font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  .case { margin-bottom: 10px; }
  .cap { font-size: 11px; color: #8d93a1; margin: 0 0 4px 2px; }
  iframe { width: 360px; height: 130px; border: 1px solid #e4e7ec; border-radius: 10px; background: #fff; }
</style>
<body>
${['6.4', '10', '88.5', 'fail', 'signedout']
  .map(
    (value) =>
      `<div class="case"><div class="cap">amount=${value}</div><iframe src="./harness.html?amount=${value}"></iframe></div>`,
  )
  .join('\n')}
</body>
</html>
`

fs.mkdirSync(path.join(root, 'preview'), { recursive: true })
fs.writeFileSync(path.join(root, 'preview/harness.html'), runner)
fs.writeFileSync(path.join(root, 'preview/harness-index.html'), index)
console.log('wrote preview/harness.html and preview/harness-index.html')
