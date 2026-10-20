/**
 * Node half: a global token-traffic meter.
 *
 * Instead of trusting one session's cumulative statistics, this counts every
 * streamed delta the Host emits — every agent, every session, every subagent —
 * and answers a single read-only route with the current rate:
 *
 *   GET /balance-gauge/traffic  →  { tokensPerSecond, windowMs, at }
 *
 * The rate is a sliding window over estimated tokens, so it rises as output
 * starts and falls to zero on its own once the stream stops. Nothing here is
 * model-facing and nothing is written to disk.
 */

/** Loader entry name. */
export const name = 'dsh-balance-gauge'

/** The route needs the Host web server; the client half needs it too. */
export const inject = ['webServer']

/** The read-only route the client polls. */
const ROUTE = '/balance-gauge/traffic'

/** Sliding window: long enough to smooth chunk jitter, short enough to fall. */
const WINDOW_MS = 3500

/** A frame and a committed chunk must not both be counted. */
const FRAME_GRACE_MS = 1500

/** CJK-heavy text packs more tokens per character than Latin text. */
function estimateTokens(text) {
  const compact = text.replace(/\s/g, '')
  if (compact.length === 0) return 0
  const cjk = (compact.match(/[\u3400-\u9fff]/g) ?? []).length
  return Math.max(1, Math.ceil(cjk * 1.5 + (compact.length - cjk) / 4))
}

/** Mount the counter and its route. */
export function apply(ctx) {
  /** One entry per streamed delta inside the window. */
  const samples = []

  /** When an assistant-stream frame was last seen, to avoid double counting. */
  let lastFrameAt = 0

  const prune = (now) => {
    const cutoff = now - WINDOW_MS
    while (samples.length > 0 && samples[0].at < cutoff) samples.shift()
  }

  const record = (text) => {
    if (typeof text !== 'string' || text.length === 0) return
    const tokens = estimateTokens(text)
    if (tokens <= 0) return
    const now = Date.now()
    samples.push({ at: now, tokens })
    prune(now)
  }

  const rate = (now) => {
    prune(now)
    let total = 0
    for (const sample of samples) total += sample.tokens
    return (total * 1000) / WINDOW_MS
  }

  // Live deltas: the current host line streams them as transient frames.
  ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload && payload.frame
    const chunk = frame && frame.chunk
    if (!chunk || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return
    lastFrameAt = Date.now()
    record(chunk.text)
  })

  // Durable fallback for compositions without the frame event: the committed
  // chunk carries the same text. Skipped while frames are flowing.
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'assistant/chunk') return
    if (Date.now() - lastFrameAt < FRAME_GRACE_MS) return
    record(event.text)
  })

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler(request, response) {
      const now = Date.now()
      const body = JSON.stringify({
        tokensPerSecond: Math.round(rate(now) * 10) / 10,
        windowMs: WINDOW_MS,
        at: now,
      })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(body)
    },
  })

  ctx.effect(() => dispose)
}
