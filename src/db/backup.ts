import { todayMarketDay } from './types'
import {
  exportSnapshot,
  importSnapshot,
  type BackupSnapshot,
} from './store'

const BACKUP_PREFIX = 'matricsx-backup_'
const BACKUP_RE = /^matricsx-backup_(\d{4})_(\d{2})_(\d{2})\.json$/
const HANDLE_DB = 'matricsx-backup-meta'
const HANDLE_STORE = 'handles'
const DIR_HANDLE_KEY = 'backupDir'
const RETENTION_KEY = 'matricsx.backupRetentionDays'
const DEFAULT_RETENTION_DAYS = 30

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getStoredDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDb()
  const tx = db.transaction(HANDLE_STORE, 'readonly')
  const handle = await new Promise<FileSystemDirectoryHandle | null>(
    (resolve, reject) => {
      const request = tx.objectStore(HANDLE_STORE).get(DIR_HANDLE_KEY)
      request.onsuccess = () =>
        resolve(
          (request.result as FileSystemDirectoryHandle | undefined) ?? null,
        )
      request.onerror = () => reject(request.error)
    },
  )
  db.close()
  return handle
}

async function setStoredDirHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openHandleDb()
  const tx = db.transaction(HANDLE_STORE, 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(HANDLE_STORE).put(handle, DIR_HANDLE_KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  db.close()
}

export function backupFileName(marketDay = todayMarketDay()): string {
  return `${BACKUP_PREFIX}${marketDay.replaceAll('-', '_')}.json`
}

export function getRetentionDays(): number {
  const raw = localStorage.getItem(RETENTION_KEY)
  const n = raw == null ? DEFAULT_RETENTION_DAYS : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS
}

export function setRetentionDays(days: number): void {
  const n = Math.max(0, Math.floor(days))
  localStorage.setItem(RETENTION_KEY, String(n))
}

function downloadJson(snapshot: BackupSnapshot, filename: string): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function ensureDirPermission(
  dir: FileSystemDirectoryHandle,
): Promise<void> {
  const permission = await dir.requestPermission({ mode: 'readwrite' })
  if (permission !== 'granted') {
    throw new Error('Data folder permission was denied.')
  }
}

async function writeToDirectory(
  dir: FileSystemDirectoryHandle,
  snapshot: BackupSnapshot,
  filename: string,
): Promise<void> {
  await ensureDirPermission(dir)
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(snapshot, null, 2))
  await writable.close()
}

function fileDay(name: string): string | null {
  const match = BACKUP_RE.exec(name)
  if (!match) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`)
  const b = Date.parse(`${later}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.floor((b - a) / 86_400_000)
}

/** Delete dated backups older than retentionDays inside the linked data folder. */
export async function pruneOldBackups(
  retentionDays = getRetentionDays(),
): Promise<number> {
  const dir = await getStoredDirHandle()
  if (!dir) return 0

  await ensureDirPermission(dir)
  const today = todayMarketDay()
  let removed = 0

  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue
    const day = fileDay(entry.name)
    if (!day) continue
    if (daysBetween(day, today) > retentionDays) {
      await dir.removeEntry(entry.name)
      removed += 1
    }
  }

  return removed
}

export async function hasLinkedDataFolder(): Promise<boolean> {
  return (await getStoredDirHandle()) !== null
}

/** Link project `data/` (or any folder) for dated JSON backups. */
export async function linkDataFolder(): Promise<string> {
  const pick = window.showDirectoryPicker
  if (!pick) {
    throw new Error(
      'This browser cannot link a folder. Use Export instead (downloads JSON).',
    )
  }

  const dir = await pick({ id: 'matricsx-data', mode: 'readwrite' })
  await setStoredDirHandle(dir)

  const snapshot = await exportSnapshot()
  const filename = backupFileName()
  await writeToDirectory(dir, snapshot, filename)
  const pruned = await pruneOldBackups()
  return pruned > 0 ? `${dir.name} (pruned ${pruned} old)` : dir.name
}

/** Write backup into linked data folder, else download dated JSON. */
export async function writeBackup(
  marketDay = todayMarketDay(),
): Promise<'folder' | 'download'> {
  const snapshot = await exportSnapshot()
  const filename = backupFileName(marketDay)
  const dir = await getStoredDirHandle()

  if (dir) {
    try {
      await writeToDirectory(dir, snapshot, filename)
      await pruneOldBackups()
      return 'folder'
    } catch {
      // Fall through to download if the linked folder is unavailable.
    }
  }

  downloadJson(snapshot, filename)
  return 'download'
}

export async function exportBackupDownload(
  marketDay = todayMarketDay(),
): Promise<string> {
  const snapshot = await exportSnapshot()
  const filename = backupFileName(marketDay)
  const dir = await getStoredDirHandle()

  if (dir) {
    try {
      await writeToDirectory(dir, snapshot, filename)
      await pruneOldBackups()
      return filename
    } catch {
      // Fall through to download.
    }
  }

  downloadJson(snapshot, filename)
  return filename
}

export async function importBackupFromFile(file: File): Promise<void> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Backup file is not valid JSON.')
  }
  await importSnapshot(parsed)
}

export type { BackupSnapshot }
