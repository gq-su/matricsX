export type Ticker = {
  id: number
  label: string
}

export type LeaderSource = 'top5' | 'prior'

/** One input row for a market day's close (top 5 or sub-zone). */
export type Leader = {
  id: number
  tickerId: number
  volprice: number
  /** Optional components; volprice may exist without them (legacy / blank amend). */
  close?: number
  volume?: number
  /** CSV percentage change for a ticker first admitted through auto-import. */
  percentChange?: number
  /** Marks a ticker newly added from the CSV's initial top-10 range. */
  isNewTicker?: boolean
  /** Market close instant (ISO 8601). Groups the day's inputs. */
  closeTime: string
  source: LeaderSource
}

export type TickerInput = {
  label: string
  close: string
  volume: string
}

export const EMPTY_ROW: TickerInput = { label: '', close: '', volume: '' }

export const EMPTY_ROWS: TickerInput[] = Array.from({ length: 5 }, () => ({
  ...EMPTY_ROW,
}))

export function parseNonNeg(value: string): number | null {
  if (value.trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** close × volume when both are valid non-negative numbers; rounded up to a whole number. */
export function calcVolPrice(close: string, volume: string): number | null {
  const c = parseNonNeg(close)
  const v = parseNonNeg(volume)
  if (c == null || v == null) return null
  return Math.ceil(c * v)
}

/** Round vol-p up to a whole number. */
export function roundVolPrice(value: number): number {
  return Math.ceil(value)
}

export function formatVolPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  return Math.ceil(value).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })
}

/** US cash equity close on a calendar day → ISO closeTime. */
export function marketCloseTime(marketDay: string): string {
  // 16:00 America/New_York ≈ 20:00/21:00 UTC; store as date + 20:00Z for stable day key.
  return `${marketDay}T20:00:00.000Z`
}

export function marketDayFromCloseTime(closeTime: string): string {
  return closeTime.slice(0, 10)
}

export function todayMarketDay(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value
  return `${year}-${month}-${day}`
}
