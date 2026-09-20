import {
  marketCloseTime,
  todayMarketDay,
  roundVolPrice,
  type Leader,
  type LeaderSource,
  type Ticker,
} from './types'

const DB_NAME = 'matricsx'
const DB_VERSION = 3
const TICKERS = 'tickers'
const LEADERS = 'leaders'

function createLeadersStore(db: IDBDatabase): IDBObjectStore {
  const leaders = db.createObjectStore(LEADERS, {
    keyPath: 'id',
    autoIncrement: true,
  })
  leaders.createIndex('tickerId', 'tickerId', { unique: false })
  leaders.createIndex('closeTime', 'closeTime', { unique: false })
  leaders.createIndex('tickerClose', ['tickerId', 'closeTime'], { unique: true })
  return leaders
}

function withSource(row: Partial<Leader>): LeaderSource {
  return row.source === 'prior' ? 'prior' : 'top5'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = request.result
      const tx = request.transaction
      const oldVersion = event.oldVersion

      if (!db.objectStoreNames.contains(TICKERS)) {
        const tickers = db.createObjectStore(TICKERS, {
          keyPath: 'id',
          autoIncrement: true,
        })
        tickers.createIndex('label', 'label', { unique: true })
      }

      if (oldVersion < 2) {
        const fallbackClose = marketCloseTime(todayMarketDay())

        if (db.objectStoreNames.contains(LEADERS) && tx) {
          const oldStore = tx.objectStore(LEADERS)
          const read = oldStore.getAll()
          read.onsuccess = () => {
            const rows = read.result as Array<Partial<Leader> & { id?: number }>
            db.deleteObjectStore(LEADERS)
            const leaders = createLeadersStore(db)
            for (const row of rows) {
              if (
                typeof row.tickerId !== 'number' ||
                typeof row.volprice !== 'number'
              ) {
                continue
              }
              leaders.put({
                ...(typeof row.id === 'number' ? { id: row.id } : {}),
                tickerId: row.tickerId,
                volprice: row.volprice,
                closeTime:
                  typeof row.closeTime === 'string' && row.closeTime
                    ? row.closeTime
                    : fallbackClose,
                source: withSource(row),
              })
            }
          }
        } else if (!db.objectStoreNames.contains(LEADERS)) {
          createLeadersStore(db)
        }
      } else if (!db.objectStoreNames.contains(LEADERS)) {
        createLeadersStore(db)
      }

      if (oldVersion >= 2 && oldVersion < 3 && tx && db.objectStoreNames.contains(LEADERS)) {
        const store = tx.objectStore(LEADERS)
        const read = store.getAll()
        read.onsuccess = () => {
          for (const row of read.result as Array<Partial<Leader> & { id: number }>) {
            store.put({
              id: row.id,
              tickerId: row.tickerId,
              volprice: row.volprice,
              closeTime: row.closeTime,
              source: withSource(row),
            })
          }
        }
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function listTickers(): Promise<Ticker[]> {
  const db = await openDb()
  const tx = db.transaction(TICKERS, 'readonly')
  const rows = await req<Ticker[]>(tx.objectStore(TICKERS).getAll())
  db.close()
  return rows
}

export async function listLeaders(): Promise<Leader[]> {
  const db = await openDb()
  const tx = db.transaction(LEADERS, 'readonly')
  const rows = await req<Array<Partial<Leader>>>(tx.objectStore(LEADERS).getAll())
  db.close()
  return rows.map((row) => ({
    id: row.id as number,
    tickerId: row.tickerId as number,
    volprice: row.volprice as number,
    ...(typeof row.close === 'number' ? { close: row.close } : {}),
    ...(typeof row.volume === 'number' ? { volume: row.volume } : {}),
    ...(typeof row.percentChange === 'number' ? { percentChange: row.percentChange } : {}),
    ...(row.isNewTicker === true ? { isNewTicker: true } : {}),
    closeTime: row.closeTime as string,
    source: withSource(row),
  }))
}

export async function listCloseTimes(): Promise<string[]> {
  const leaders = await listLeaders()
  return [...new Set(leaders.map((l) => l.closeTime))].sort((a, b) =>
    b.localeCompare(a),
  )
}

/** Labels that have ever been in a top-5 close, excluding the given set. */
export async function listPriorLeaderLabels(
  excludeLabels: Iterable<string> = [],
): Promise<string[]> {
  const excluded = new Set(
    [...excludeLabels].map((label) => label.trim().toLowerCase()).filter(Boolean),
  )
  const [tickers, leaders] = await Promise.all([listTickers(), listLeaders()])
  const byId = new Map(tickers.map((t) => [t.id, t.label]))
  const labels = new Set<string>()

  for (const leader of leaders) {
    if (leader.source !== 'top5') continue
    const label = byId.get(leader.tickerId)
    if (!label || excluded.has(label)) continue
    labels.add(label)
  }

  return [...labels].sort()
}

/** Find ticker by label, or insert a new row when missing. */
export async function ensureTicker(label: string): Promise<Ticker> {
  const normalized = label.trim().toLowerCase()
  if (!normalized) {
    throw new Error('Ticker label is required')
  }

  const db = await openDb()
  const tx = db.transaction(TICKERS, 'readwrite')
  const store = tx.objectStore(TICKERS)
  const index = store.index('label')
  const existing = await req<Ticker | undefined>(index.get(normalized))

  if (existing) {
    await txDone(tx)
    db.close()
    return existing
  }

  const id = Number(await req(store.add({ label: normalized })))
  await txDone(tx)
  db.close()
  return { id, label: normalized }
}

export type DayEntry = {
  tickerId: number
  volprice: number
  close?: number
  volume?: number
  percentChange?: number
  isNewTicker?: boolean
  source: LeaderSource
}

/**
 * Replace all inputs for a market close (top 5 + sub-zone rows).
 * Top 5 capped at 5; sub-zone stored in full.
 */
export async function saveDayInputs(
  closeTime: string,
  top5: Array<{
    tickerId: number
    volprice: number
    close?: number
    volume?: number
    percentChange?: number
    isNewTicker?: boolean
  }>,
  priors: Array<{
    tickerId: number
    volprice: number
    close?: number
    volume?: number
    percentChange?: number
    isNewTicker?: boolean
  }> = [],
): Promise<Leader[]> {
  if (!closeTime) {
    throw new Error('closeTime is required')
  }

  const rankedTop = [...top5]
    .sort((a, b) => b.volprice - a.volprice)
    .slice(0, 5)
    .map((entry) => ({ ...entry, source: 'top5' as const }))

  const topIds = new Set(rankedTop.map((e) => e.tickerId))
  const priorEntries = priors
    .filter((entry) => !topIds.has(entry.tickerId))
    .map((entry) => ({ ...entry, source: 'prior' as const }))

  const all = [...rankedTop, ...priorEntries]

  const db = await openDb()
  const tx = db.transaction(LEADERS, 'readwrite')
  const store = tx.objectStore(LEADERS)
  const existing = await req<Leader[]>(store.index('closeTime').getAll(closeTime))

  for (const row of existing) {
    await req(store.delete(row.id))
  }

  const saved: Leader[] = []
  for (const entry of all) {
    const record: Omit<Leader, 'id'> = {
      tickerId: entry.tickerId,
      volprice: roundVolPrice(entry.volprice),
      closeTime,
      source: entry.source,
      ...(typeof entry.close === 'number' ? { close: entry.close } : {}),
      ...(typeof entry.volume === 'number' ? { volume: entry.volume } : {}),
      ...(typeof entry.percentChange === 'number' ? { percentChange: entry.percentChange } : {}),
      ...(entry.isNewTicker === true ? { isNewTicker: true } : {}),
    }
    const id = Number(await req(store.add(record)))
    saved.push({ id, ...record })
  }

  await txDone(tx)
  db.close()
  return saved
}

/** @deprecated use saveDayInputs */
export async function saveLeadersForClose(
  closeTime: string,
  entries: Array<{ tickerId: number; volprice: number }>,
): Promise<Leader[]> {
  return saveDayInputs(closeTime, entries, [])
}

/** Delete every leader row for a market close (by date/closeTime). */
export async function deleteLeadersForClose(closeTime: string): Promise<number> {
  if (!closeTime) {
    throw new Error('closeTime is required')
  }

  const db = await openDb()
  const tx = db.transaction(LEADERS, 'readwrite')
  const store = tx.objectStore(LEADERS)
  const existing = await req<Leader[]>(store.index('closeTime').getAll(closeTime))

  for (const row of existing) {
    await req(store.delete(row.id))
  }

  await txDone(tx)
  db.close()
  return existing.length
}

/** Delete one leader row by id. */
export async function deleteLeader(id: number): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(LEADERS, 'readwrite')
  await req(tx.objectStore(LEADERS).delete(id))
  await txDone(tx)
  db.close()
}

/** Amend close / volume / vol-p for one day row.
 * If close+volume both provided, volprice is recalculated.
 * If either is blank/omitted, existing volprice is preserved.
 */
export async function updateLeader(
  id: number,
  patch: {
    close?: number | null
    volume?: number | null
    volprice?: number
    source?: LeaderSource
  },
): Promise<Leader> {
  const db = await openDb()
  const tx = db.transaction(LEADERS, 'readwrite')
  const store = tx.objectStore(LEADERS)
  const existing = await req<Partial<Leader> | undefined>(store.get(id))

  if (!existing || typeof existing.id !== 'number') {
    throw new Error('Leader row not found.')
  }

  const nextClose =
    patch.close === null
      ? undefined
      : typeof patch.close === 'number'
        ? patch.close
        : existing.close
  const nextVolume =
    patch.volume === null
      ? undefined
      : typeof patch.volume === 'number'
        ? patch.volume
        : existing.volume

  const bothComponents =
    typeof nextClose === 'number' && typeof nextVolume === 'number'

  const updated: Leader = {
    id: existing.id,
    tickerId: existing.tickerId as number,
    volprice: bothComponents
      ? roundVolPrice(nextClose * nextVolume)
      : typeof patch.volprice === 'number'
        ? roundVolPrice(patch.volprice)
        : roundVolPrice(existing.volprice as number),
    closeTime: existing.closeTime as string,
    source: patch.source ?? withSource(existing),
    ...(typeof nextClose === 'number' ? { close: nextClose } : {}),
    ...(typeof nextVolume === 'number' ? { volume: nextVolume } : {}),
    ...(typeof existing.percentChange === 'number' ? { percentChange: existing.percentChange } : {}),
    ...(existing.isNewTicker === true ? { isNewTicker: true } : {}),
  }

  await req(store.put(updated))
  await txDone(tx)
  db.close()
  return updated
}

export type LeaderRow = {
  id: number
  tickerId: number
  label: string
  volprice: number
  close?: number
  volume?: number
  percentChange?: number
  isNewTicker?: boolean
  closeTime: string
  source: LeaderSource
  rank: number
}

/** All saved inputs for a close, sorted by vol-p descending. */
export async function getDayInputs(closeTime: string): Promise<LeaderRow[]> {
  const [tickers, leaders] = await Promise.all([listTickers(), listLeaders()])
  const byId = new Map(tickers.map((t) => [t.id, t.label]))

  return leaders
    .filter((leader) => leader.closeTime === closeTime)
    .sort((a, b) => b.volprice - a.volprice)
    .map((leader, index) => ({
      id: leader.id,
      tickerId: leader.tickerId,
      label: byId.get(leader.tickerId) ?? '?',
      volprice: leader.volprice,
      ...(typeof leader.close === 'number' ? { close: leader.close } : {}),
      ...(typeof leader.volume === 'number' ? { volume: leader.volume } : {}),
      ...(typeof leader.percentChange === 'number' ? { percentChange: leader.percentChange } : {}),
      ...(leader.isNewTicker === true ? { isNewTicker: true } : {}),
      closeTime: leader.closeTime,
      source: leader.source,
      rank: index + 1,
    }))
}

/** Top 5 only (source top5), for convenience. */
export async function getLeaderboard(closeTime: string): Promise<LeaderRow[]> {
  const rows = await getDayInputs(closeTime)
  return rows
    .filter((row) => row.source === 'top5')
    .slice(0, 5)
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

export type BackupSnapshot = {
  version: 3
  exportedAt: string
  tickers: Ticker[]
  leaders: Leader[]
}

export async function exportSnapshot(): Promise<BackupSnapshot> {
  const [tickers, leaders] = await Promise.all([listTickers(), listLeaders()])
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    tickers,
    leaders,
  }
}

function normalizeLeaders(value: unknown): Leader[] {
  if (!value || typeof value !== 'object') return []
  const snap = value as { version?: number; leaders?: unknown[] }
  if (!Array.isArray(snap.leaders)) return []

  const fallbackClose = marketCloseTime(todayMarketDay())

  return snap.leaders.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new Error(`Backup leader row ${index} is invalid.`)
    }
    const leader = row as Partial<Leader>
    if (
      typeof leader.id !== 'number' ||
      typeof leader.tickerId !== 'number' ||
      typeof leader.volprice !== 'number'
    ) {
      throw new Error(`Backup leader row ${index} is invalid.`)
    }
    return {
      id: leader.id,
      tickerId: leader.tickerId,
      volprice: leader.volprice,
      ...(typeof leader.close === 'number' ? { close: leader.close } : {}),
      ...(typeof leader.volume === 'number' ? { volume: leader.volume } : {}),
      ...(typeof leader.percentChange === 'number' ? { percentChange: leader.percentChange } : {}),
      ...(leader.isNewTicker === true ? { isNewTicker: true } : {}),
      closeTime:
        typeof leader.closeTime === 'string' && leader.closeTime
          ? leader.closeTime
          : fallbackClose,
      source: withSource(leader),
    }
  })
}

function isBackupSnapshot(
  value: unknown,
): value is { version: 1 | 2 | 3; tickers: Ticker[]; leaders: unknown[] } {
  if (!value || typeof value !== 'object') return false
  const snap = value as { version?: number; tickers?: unknown; leaders?: unknown }
  return (
    (snap.version === 1 || snap.version === 2 || snap.version === 3) &&
    Array.isArray(snap.tickers) &&
    Array.isArray(snap.leaders)
  )
}

/** Replace IndexedDB contents from a JSON backup (v1–v3). */
export async function importSnapshot(value: unknown): Promise<void> {
  if (!isBackupSnapshot(value)) {
    throw new Error('Unrecognized backup format.')
  }

  const leaders = normalizeLeaders(value)

  const db = await openDb()
  const tx = db.transaction([TICKERS, LEADERS], 'readwrite')
  const tickerStore = tx.objectStore(TICKERS)
  const leaderStore = tx.objectStore(LEADERS)

  await req(tickerStore.clear())
  await req(leaderStore.clear())

  for (const ticker of value.tickers) {
    if (
      typeof ticker.id !== 'number' ||
      typeof ticker.label !== 'string' ||
      !ticker.label.trim()
    ) {
      throw new Error('Backup contains an invalid ticker row.')
    }
    await req(
      tickerStore.put({
        id: ticker.id,
        label: ticker.label.trim().toLowerCase(),
      }),
    )
  }

  for (const leader of leaders) {
    await req(leaderStore.put(leader))
  }

  await txDone(tx)
  db.close()
}
