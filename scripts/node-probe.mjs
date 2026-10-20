/**
 * Node-half probe (dev only, not shipped).
 *
 * Mounts lib/index.js against a fake Cordis context — a route registry and an
 * event bus — pushes synthetic assistant-stream frames through it, then calls
 * the registered route handler and reports the rate it answers with. This is
 * the only way to check the traffic meter without restarting the Host.
 *
 *   node scripts/node-probe.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(`file:///${path.join(root, 'lib/index.js').replace(/\\/g, '/')}`)

const handlers = new Map()
const disposed = []
let route = null

const ctx = {
  on(name, callback) {
    handlers.set(name, callback)
    return () => handlers.delete(name)
  },
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') disposed.push(dispose)
    return dispose
  },
  webServer: {
    register(candidate) {
      route = candidate
      return () => {
        route = null
      }
    },
  },
}

plugin.apply(ctx)

const emitFrames = (count, text) => {
  const handler = handlers.get('agent/assistant-stream')
  if (handler === undefined) throw new Error('no agent/assistant-stream listener')
  for (let index = 0; index < count; index += 1) {
    handler({ agent: { session: { id: 's' } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } })
  }
}

const readRoute = async () => {
  if (route === null) throw new Error('route not registered')
  const response = {
    status: 200,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
  await route.handler({ url: route.path, headers: {} }, response)
  return { status: response.status, headers: response.headers, body: JSON.parse(response.body) }
}

const report = []
report.push(`route: ${route === null ? 'MISSING' : `${route.kind} ${route.path}`}`)
report.push(`listeners: ${[...handlers.keys()].join(', ')}`)

// Idle: nothing emitted yet.
const idle = await readRoute()
report.push(`idle → ${JSON.stringify(idle.body)}`)
if (idle.body.tokensPerSecond !== 0) report.push('FAIL idle rate should be 0')

// 10 deltas of "hello world" → 3 tokens each (ceil(11/4)) → 30 tokens / 3.5s.
emitFrames(10, 'hello world')
const busy = await readRoute()
report.push(`after 10×"hello world" → ${JSON.stringify(busy.body)}`)
const expected = Math.round(((30 * 1000) / busy.body.windowMs) * 10) / 10
if (Math.abs(busy.body.tokensPerSecond - expected) > 0.2) {
  report.push(`FAIL expected ~${expected}, got ${busy.body.tokensPerSecond}`)
}

// Reasoning deltas count too; ordinary text and tool deltas must not.
const handler = handlers.get('agent/assistant-stream')
handler({ frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '思考一下' } } })
handler({ frame: { type: 'chunk', chunk: { type: 'tool-call-delta', text: 'ignored' } } })
const afterReasoning = await readRoute()
report.push(`after reasoning delta → ${JSON.stringify(afterReasoning.body)}`)
if (afterReasoning.body.tokensPerSecond <= busy.body.tokensPerSecond) {
  report.push('FAIL reasoning delta should raise the rate')
}

// A committed chunk right after frames must not double count.
const sessionHandler = handlers.get('session/event')
sessionHandler({ id: 's' }, { type: 'assistant/chunk', text: 'hello world' })
const afterDedup = await readRoute()
report.push(`after committed chunk (dedup window) → ${JSON.stringify(afterDedup.body)}`)
if (afterDedup.body.tokensPerSecond !== afterReasoning.body.tokensPerSecond) {
  report.push('FAIL committed chunk was counted while frames are flowing')
}

// Disposal releases the route.
for (const dispose of disposed) dispose()
report.push(`after dispose: route ${route === null ? 'released' : 'LEAKED'}`)

console.log(report.join('\n'))
