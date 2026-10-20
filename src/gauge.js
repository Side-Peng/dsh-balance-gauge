/**
 * Money / speed → gauge geometry, colour zones and copy.
 *
 * Pure: no DOM, no React. The client bundle and the offline preview both use
 * these functions, so the widget you look at and the widget that ships cannot
 * drift apart.
 */

/** Full tank: the needle sits on the right end of the scale at this amount. */
export const FULL_SCALE = 100

/** Below this the gauge is red. Strict: 10 itself is still amber. */
export const LOW_THRESHOLD = 10

/** Above this the gauge is green. Strict: 50 itself is still amber. */
export const HIGH_THRESHOLD = 50

/**
 * Speedometer full scale, in tokens per second: 0 tok/s sits at the left end of
 * the 180° sweep, 500 tok/s at the right end.
 */
export const SPEED_MAX = 500

/** One colour per zone, plus a neutral one for "no reading". */
export const ZONE_COLORS = {
  low: '#D96C64',
  mid: '#D9A05F',
  high: '#6BA689',
  unknown: '#C9CED8',
}

/**
 * Ink for the amount, a shade deeper than the arc so the number stays legible.
 * Mid uses the ordinary label colour.
 */
export const ZONE_INK = {
  low: '#C0554D',
  mid: '',
  high: '#3F8A66',
  unknown: '',
}

/** The three painted ranges, in scale units. */
export const ZONES = [
  { zone: 'low', from: 0, to: LOW_THRESHOLD },
  { zone: 'mid', from: LOW_THRESHOLD, to: HIGH_THRESHOLD },
  { zone: 'high', from: HIGH_THRESHOLD, to: FULL_SCALE },
]

/** Per-state copy: an emoji plus a short, colloquial line. */
export const COPY = {
  high: { emoji: '😄', text: '油箱满满' },
  mid: { emoji: '🙂', text: '还够跑一阵' },
  low: { emoji: '😰', text: '油快没啦' },
  loading: { emoji: '⛽', text: '正在量油…' },
  unavailable: { emoji: '🔒', text: '先登录账户' },
  failed: { emoji: '🥲', text: '读不到数，点我重试' },
}

/** Dial centre and radius, in viewBox units. */
const CX = 60
const CY = 60
const RADIUS = 42

/** Gap, in degrees, cut out of the arc at each zone boundary. */
const GAP_DEG = 2.2

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** The zone a balance falls in. */
export function zoneOf(balance) {
  if (!Number.isFinite(balance)) return 'unknown'
  if (balance < LOW_THRESHOLD) return 'low'
  if (balance > HIGH_THRESHOLD) return 'high'
  return 'mid'
}

/** Needle position as a 0–1 fraction of the money scale. */
export function percentOf(balance) {
  if (!Number.isFinite(balance)) return 0
  return clamp(balance / FULL_SCALE, 0, 1)
}

/** Needle position as a 0–1 fraction of the speed scale. */
export function speedPercent(speed) {
  if (!Number.isFinite(speed) || speed <= 0) return 0
  return clamp(speed / SPEED_MAX, 0, 1)
}

/** Whole tokens per second; sub-1 readings collapse to 0. */
export function formatSpeed(speed) {
  if (!Number.isFinite(speed) || speed <= 0) return '0'
  return String(Math.round(speed))
}

/** The needle's CSS rotation: -90deg points at empty, +90deg at full. */
export function needleDegrees(percent) {
  return clamp(percent, 0, 1) * 180 - 90
}

/** Group digits: 1234.5 → 1,234.50. */
function groupDigits(fixed) {
  const [whole, fraction] = fixed.split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`)
}

/** A currency symbol, or the code itself for currencies we do not know. */
export function currencySymbol(currency) {
  if (currency === 'CNY' || currency === 'RMB') return '¥'
  if (currency === 'USD') return '$'
  return typeof currency === 'string' && currency.length > 0 ? `${currency} ` : '¥'
}

/** Two decimals, thousands grouped, symbol first. */
export function formatMoney(balance, currency) {
  const value = Number(balance)
  const fixed = Number.isFinite(value) ? value.toFixed(2) : '0.00'
  return `${currencySymbol(currency)}${groupDigits(fixed)}`
}

/** Point on the dial for an angle measured from the positive x axis. */
function polar(degrees, radius) {
  const radians = (degrees * Math.PI) / 180
  return {
    x: CX + radius * Math.cos(radians),
    y: CY - radius * Math.sin(radians),
  }
}

/**
 * One clockwise arc between two scale fractions.
 *
 * 0 is the left end of the semicircle, 1 the right end; both ends sit on the
 * dial's horizontal diameter.
 */
export function arcPath(fromPercent, toPercent, radius = RADIUS) {
  const fromDeg = 180 - clamp(fromPercent, 0, 1) * 180
  const toDeg = 180 - clamp(toPercent, 0, 1) * 180
  const start = polar(fromDeg, radius)
  const end = polar(toDeg, radius)
  const largeArc = Math.abs(fromDeg - toDeg) > 180 ? 1 : 0
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

/** The three coloured arcs, with a small gap cut at each boundary. */
export function zonePaths() {
  const gap = GAP_DEG / 180
  return ZONES.map(({ zone, from, to }) => {
    const fromPercent = from / FULL_SCALE
    const toPercent = to / FULL_SCALE
    const start = from === 0 ? fromPercent : fromPercent + gap
    const end = to === FULL_SCALE ? toPercent : toPercent - gap
    return { zone, color: ZONE_COLORS[zone], d: arcPath(start, end) }
  })
}

/** The needle geometry, shared by the string and React renderers. */
export const NEEDLE = {
  blade: '57.4,60 60,28.5 62.6,60',
  hubRadius: 5.4,
  dotRadius: 1.9,
  glowRadius: 11,
}

/** The track plus the three coloured zone arcs, as an SVG fragment string. */
export function dialTracks(options) {
  const zone = (options && options.zone) || 'unknown'
  const dim = !!(options && options.dim)
  const pulse = zone === 'low' && !dim ? ' bg-pulse' : ''
  const arcs = zonePaths()
    .map(({ zone: name, color, d }) => `<path class="bg-arc${name === zone ? pulse : ''}" d="${d}" stroke="${color}" />`)
    .join('')
  return `<path class="bg-track" d="${arcPath(0, 1)}" />${arcs}`
}

/** The track plus the accent arc filled up to the reading, as a string. */
export function speedTracks(options) {
  const percent = clamp(Number(options && options.percent) || 0, 0, 1)
  const filled = percent > 0.004 ? `<path class="bg-arc bg-speed" d="${arcPath(0, percent)}" />` : ''
  return `<path class="bg-track" d="${arcPath(0, 1)}" />${filled}`
}

/** Static needle markup, for the offline preview (the app animates it). */
function needleMarkup(percent, tint, dim) {
  if (dim) return ''
  const rotation = needleDegrees(percent).toFixed(2)
  return (
    `<g class="bg-needle" style="transform: rotate(${rotation}deg)">` +
    `<circle cx="60" cy="60" r="${NEEDLE.glowRadius}" class="bg-glow" fill="${tint}" opacity="0.14" />` +
    `<polygon class="bg-blade" points="${NEEDLE.blade}" />` +
    `<circle cx="60" cy="60" r="${NEEDLE.hubRadius}" class="bg-hub" />` +
    `<circle cx="60" cy="60" r="${NEEDLE.dotRadius}" class="bg-hub-dot" />` +
    `</g>`
  )
}

/**
 * The balance dial as a complete SVG string (static needle).
 *
 * The client bundle renders the tracks and the needle separately so it can
 * animate the needle in place; this whole-string form is for the preview.
 */
export function dialSvg(options) {
  const percent = clamp(Number(options && options.percent) || 0, 0, 1)
  const zone = (options && options.zone) || 'unknown'
  const dim = !!(options && options.dim)
  const tint = ZONE_COLORS[zone] || ZONE_COLORS.unknown
  const label = `余额油量 ${Math.round(percent * 100)}%`
  return (
    `<svg class="bg-dial" viewBox="0 0 120 68" role="img" aria-label="${label}">` +
    dialTracks(options) +
    needleMarkup(percent, tint, dim) +
    `</svg>`
  )
}

/**
 * The speedometer dial as a complete SVG string (static needle).
 *
 * The accent comes from the theme token (`--dsw-alias-state-business-primary`)
 * via the `.bg-speed` class, because a CSS variable cannot be written into a
 * stroke attribute.
 */
export function speedDialSvg(options) {
  const percent = clamp(Number(options && options.percent) || 0, 0, 1)
  const dim = !!(options && options.dim)
  const label = `输出速度 ${Math.round(percent * 100)}%`
  return (
    `<svg class="bg-dial" viewBox="0 0 120 68" role="img" aria-label="${label}">` +
    speedTracks(options) +
    needleMarkup(percent, '#4D6BFE', dim) +
    `</svg>`
  )
}
