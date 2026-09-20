import { restoreLatestBackupForCsvImport } from './backup'
import { ensureTicker, listTickers, saveDayInputs } from './store'
import { marketCloseTime, roundVolPrice } from './types'

type CsvRecord = Record<string, string>

export type CsvImportResult = {
  marketDay: string
  rows: number
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (quoted) throw new Error('CSV has an unclosed quoted value.')
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

function csvNumber(value: string): number | null {
  const normalized = value.replaceAll(',', '').replaceAll('$', '').trim()
  if (!normalized) return null
  const result = Number(normalized)
  return Number.isFinite(result) && result >= 0 ? result : null
}

function csvSignedNumber(value: string): number | null {
  const normalized = value
    .replaceAll(',', '')
    .replaceAll('$', '')
    .replaceAll('%', '')
    .trim()
  if (!normalized) return null
  const result = Number(normalized)
  return Number.isFinite(result) ? result : null
}

function marketDay(value: string): string | null {
  const isoDay = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())?.[1]
  if (isoDay) return isoDay

  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(parsed)
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join('-')
}

/**
 * Import the price-volume-leader-board CSV format. Each CSV day replaces only
 * that day's saved rows; the five largest Price Vol rows become the top five.
 */
export async function importPriceVolumeLeaderboardCsv(
  file: File,
): Promise<CsvImportResult> {
  const rows = parseCsv(await file.text())
  const [header, ...data] = rows
  if (!header) throw new Error('CSV is empty.')

  const keys = header.map((value) => value.trim().toLowerCase())
  const required = ['symbol', 'latest', '%change', 'volume', 'price vol', 'time']
  const missing = required.filter((key) => !keys.includes(key))
  if (missing.length) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}.`)
  }

  const entries: Array<{
    label: string
    close: number
    volume: number
    csvPriceVol: number
    percentChange: number
  }> = []
  let csvMarketDay: string | null = null

  for (const [index, values] of data.entries()) {
    const record = Object.fromEntries(
      keys.map((key, column) => [key, values[column] ?? '']),
    ) as CsvRecord
    const label = record.symbol.trim().toLowerCase()
    const close = csvNumber(record.latest)
    const percentChange = csvSignedNumber(record['%change'])
    const volume = csvNumber(record.volume)
    const priceVol = csvNumber(record['price vol'])
    const day = marketDay(record.time)

    if (!label && values.every((value) => !value.trim())) continue
    // Barchart exports end with an attribution row such as
    // "Downloaded from Barchart.com as of …,,,,,,,". It is metadata, not a
    // market record, and must not prevent the preceding ticker rows importing.
    if (label.startsWith('downloaded from barchart.com')) continue
    if (!label || close == null || percentChange == null || volume == null || priceVol == null || day == null) {
      throw new Error(
        `CSV row ${index + 2} needs Symbol, Latest, %Change, Volume, Price Vol, and Time.`,
      )
    }
    if (csvMarketDay && csvMarketDay !== day) {
      throw new Error('CSV must contain rows from one market day only.')
    }
    csvMarketDay = day
    if (entries.some((item) => item.label === label)) {
      throw new Error(`CSV has duplicate ${label.toUpperCase()} rows for ${day}.`)
    }
    entries.push({ label, close, percentChange, volume, csvPriceVol: priceVol })
  }

  if (!csvMarketDay) throw new Error('CSV has no data rows.')

  const restored = await restoreLatestBackupForCsvImport()
  if (restored.latestMarketDay && csvMarketDay <= restored.latestMarketDay) {
    throw new Error(
      `${csvMarketDay} is already recorded. Import a trading day later than ${restored.latestMarketDay}.`,
    )
  }

  const tickerByLabel = new Map((await listTickers()).map((ticker) => [ticker.label, ticker]))
  const sorted = [...entries].sort((a, b) => b.csvPriceVol - a.csvPriceVol)
  const top5: Array<{ tickerId: number; close: number; volume: number; volprice: number }> = []
  const priors: Array<{ tickerId: number; close: number; volume: number; volprice: number }> = []

  for (const [index, entry] of sorted.entries()) {
    let ticker = tickerByLabel.get(entry.label)
    const withinInitialZone = index < 10
    if (!ticker && !withinInitialZone) continue
    const isNewTicker = !ticker
    if (!ticker) {
      ticker = await ensureTicker(entry.label)
      tickerByLabel.set(ticker.label, ticker)
    }

    const record = {
      tickerId: ticker.id,
      close: entry.close,
      volume: entry.volume,
      volprice: roundVolPrice(entry.close * entry.volume),
      ...(isNewTicker
        ? { percentChange: entry.percentChange, isNewTicker: true }
        : {}),
    }
    if (index < 5) top5.push(record)
    else priors.push(record)
  }

  await saveDayInputs(marketCloseTime(csvMarketDay), top5, priors)
  return { marketDay: csvMarketDay, rows: top5.length + priors.length }
}
