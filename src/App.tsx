import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { TickerSearchInput } from './components/TickerSearchInput'
import {
  exportBackupDownload,
  getRetentionDays,
  hasLinkedDataFolder,
  importBackupFromFile,
  linkDataFolder,
  pruneOldBackups,
  setRetentionDays,
  writeBackup,
} from './db/backup'
import { importPriceVolumeLeaderboardCsv } from './db/csv'
import {
  deleteLeader,
  deleteLeadersForClose,
  ensureTicker,
  getDayInputs,
  listCloseTimes,
  listPriorLeaderLabels,
  listTickers,
  saveDayInputs,
  updateLeader,
  type LeaderRow,
} from './db/store'
import {
  calcVolPrice,
  EMPTY_ROWS,
  formatVolPrice,
  marketCloseTime,
  marketDayFromCloseTime,
  parseNonNeg,
  todayMarketDay,
  type TickerInput,
} from './db/types'
import './App.css'

type DayEdit = { close: string; volume: string }

function entryPayload(close: string, volume: string) {
  const c = parseNonNeg(close)
  const v = parseNonNeg(volume)
  const volprice = calcVolPrice(close, volume)
  if (volprice == null || c == null || v == null) return null
  return { close: c, volume: v, volprice }
}

function formatPercentChange(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`
}

function App() {
  const [rows, setRows] = useState<TickerInput[]>(EMPTY_ROWS)
  const [priorPick, setPriorPick] = useState('')
  const [priorClose, setPriorClose] = useState('')
  const [priorVolume, setPriorVolume] = useState('')
  const [marketDay, setMarketDay] = useState(todayMarketDay)
  const [closeTimes, setCloseTimes] = useState<string[]>([])
  const [tickerLabels, setTickerLabels] = useState<string[]>([])
  const [priorOptions, setPriorOptions] = useState<string[]>([])
  const [dayRows, setDayRows] = useState<LeaderRow[]>([])
  const [dayEdits, setDayEdits] = useState<Record<number, DayEdit>>({})
  const [status, setStatus] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [linked, setLinked] = useState(false)
  const [retentionDays, setRetentionDaysState] = useState(getRetentionDays)
  const importRef = useRef<HTMLInputElement>(null)
  const csvImportRef = useRef<HTMLInputElement>(null)

  const selectedClose = marketCloseTime(marketDay)
  const priorVolPrice = calcVolPrice(priorClose, priorVolume)

  const currentTopLabels = useMemo(
    () =>
      new Set(
        rows
          .map((row) => row.label.trim().toLowerCase())
          .filter(Boolean),
      ),
    [rows],
  )

  const dayLabels = useMemo(
    () => new Set(dayRows.map((row) => row.label)),
    [dayRows],
  )

  const subzoneSuggestions = useMemo(() => {
    const blocked = new Set([...currentTopLabels, ...dayLabels])
    const merged = new Set([...tickerLabels, ...priorOptions])
    return [...merged].filter((label) => !blocked.has(label)).sort()
  }, [tickerLabels, priorOptions, currentTopLabels, dayLabels])

  async function refreshPriorOptions(topLabels: Iterable<string>) {
    const exclude = new Set(
      [...topLabels, ...dayLabels].map((l) => l.trim().toLowerCase()),
    )
    setPriorOptions(await listPriorLeaderLabels(exclude))
  }

  function syncDayEdits(board: LeaderRow[]) {
    setDayEdits(
      Object.fromEntries(
        board.map((row) => [
          row.id,
          {
            close: row.close != null ? String(row.close) : '',
            volume: row.volume != null ? String(row.volume) : '',
          },
        ]),
      ),
    )
  }

  async function refresh(day = marketDay) {
    const close = marketCloseTime(day)
    const [board, times, tickers, hasLink] = await Promise.all([
      getDayInputs(close),
      listCloseTimes(),
      listTickers(),
      hasLinkedDataFolder(),
    ])
    setDayRows(board)
    syncDayEdits(board)
    setCloseTimes(times)
    setTickerLabels(tickers.map((t) => t.label).sort())
    setLinked(hasLink)
    const exclude = new Set([
      ...rows.map((r) => r.label.trim().toLowerCase()),
      ...board.map((r) => r.label),
    ])
    setPriorOptions(await listPriorLeaderLabels(exclude))
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    void refreshPriorOptions(currentTopLabels)
  }, [currentTopLabels, dayLabels])

  function updateRow(index: number, field: keyof TickerInput, value: string) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    )
  }

  function existingDayEntries() {
    const top5 = dayRows
      .filter((row) => row.source === 'top5')
      .map((row) => ({
        tickerId: row.tickerId,
        volprice: row.volprice,
        ...(row.close != null ? { close: row.close } : {}),
        ...(row.volume != null ? { volume: row.volume } : {}),
        ...(row.percentChange != null ? { percentChange: row.percentChange } : {}),
        ...(row.isNewTicker ? { isNewTicker: true } : {}),
      }))
    const priors = dayRows
      .filter((row) => row.source === 'prior')
      .map((row) => ({
        tickerId: row.tickerId,
        volprice: row.volprice,
        ...(row.close != null ? { close: row.close } : {}),
        ...(row.volume != null ? { volume: row.volume } : {}),
        ...(row.percentChange != null ? { percentChange: row.percentChange } : {}),
        ...(row.isNewTicker ? { isNewTicker: true } : {}),
      }))
    return { top5, priors }
  }

  async function addPriorToDayList() {
    const label = priorPick.trim().toLowerCase()
    const payload = entryPayload(priorClose, priorVolume)

    if (!label) {
      setStatus('Enter a ticker symbol.')
      return
    }
    if (!payload) {
      setStatus(`Enter valid close and volume for ${label || 'ticker'}.`)
      return
    }
    if (currentTopLabels.has(label) || dayLabels.has(label)) {
      setStatus(`${label.toUpperCase()} is already on this day’s list.`)
      return
    }

    try {
      const ticker = await ensureTicker(label)
      const { top5, priors } = existingDayEntries()
      priors.push({ tickerId: ticker.id, ...payload })
      await saveDayInputs(selectedClose, top5, priors)
      await writeBackup(marketDay)
      setPriorPick('')
      setPriorClose('')
      setPriorVolume('')
      await refresh(marketDay)
      setStatus(`Added ${label.toUpperCase()} to ${marketDay} sub-zone list.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Add failed.')
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setStatus('')

    try {
      const filled = rows.filter((row) => row.label.trim() !== '')
      if (filled.length === 0) {
        setStatus('Enter at least one top-5 ticker.')
        return
      }
      if (filled.length > 5) {
        setStatus('Top 5 only — enter at most five tickers.')
        return
      }
      if (!marketDay) {
        setStatus('Pick a market day.')
        return
      }

      const top5: Array<{
        tickerId: number
        volprice: number
        close: number
        volume: number
      }> = []
      for (const row of filled) {
        const payload = entryPayload(row.close, row.volume)
        if (!payload) {
          setStatus(`Enter valid close and volume for ${row.label.trim()}.`)
          return
        }
        const ticker = await ensureTicker(row.label)
        top5.push({ tickerId: ticker.id, ...payload })
      }

      const topIds = new Set(top5.map((e) => e.tickerId))
      const priors = dayRows
        .filter((row) => row.source === 'prior' && !topIds.has(row.tickerId))
        .map((row) => ({
          tickerId: row.tickerId,
          volprice: row.volprice,
          ...(row.close != null ? { close: row.close } : {}),
          ...(row.volume != null ? { volume: row.volume } : {}),
          ...(row.percentChange != null ? { percentChange: row.percentChange } : {}),
          ...(row.isNewTicker ? { isNewTicker: true } : {}),
        }))

      await saveDayInputs(selectedClose, top5, priors)
      const mode = await writeBackup(marketDay)
      setRows(EMPTY_ROWS)
      await refresh(marketDay)
      setStatus(
        mode === 'folder'
          ? `Saved top ${top5.length} for ${marketDay} → data/.`
          : `Saved top ${top5.length} for ${marketDay} → dated JSON.`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function onApplyDayComponents(row: LeaderRow) {
    const edit = dayEdits[row.id] ?? { close: '', volume: '' }
    const closeBlank = edit.close.trim() === ''
    const volumeBlank = edit.volume.trim() === ''

    try {
      if (closeBlank && volumeBlank) {
        // Leave stored vol-p untouched; clear stored components.
        await updateLeader(row.id, { close: null, volume: null })
        await writeBackup(marketDay)
        await refresh(marketDay)
        setStatus(
          `Cleared close/volume for ${row.label.toUpperCase()}; vol-p kept.`,
        )
        return
      }

      const c = parseNonNeg(edit.close)
      const v = parseNonNeg(edit.volume)
      if (c == null || v == null) {
        setStatus(
          `Enter both close and volume for ${row.label.toUpperCase()}, or leave both blank to keep vol-p.`,
        )
        return
      }

      await updateLeader(row.id, { close: c, volume: v })
      await writeBackup(marketDay)
      await refresh(marketDay)
      setStatus(`Updated close/volume for ${row.label.toUpperCase()}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Update failed.')
    }
  }

  async function onLinkFolder() {
    try {
      const name = await linkDataFolder()
      setLinked(true)
      setStatus(`Linked data folder: ${name}. Prefer project ./data`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus(error instanceof Error ? error.message : 'Could not link folder.')
    }
  }

  async function onExport() {
    try {
      const filename = await exportBackupDownload(marketDay)
      setStatus(`Exported ${filename}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  async function onApplyRetention() {
    setRetentionDays(retentionDays)
    try {
      const removed = await pruneOldBackups(retentionDays)
      setStatus(
        linked
          ? `Retention set to ${retentionDays} day(s); pruned ${removed} old file(s).`
          : `Retention set to ${retentionDays} day(s). Link data/ to prune files.`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Prune failed.')
    }
  }

  async function onImportFile(file: File | undefined) {
    if (!file) return
    try {
      await importBackupFromFile(file)
      await writeBackup(marketDay)
      await refresh(marketDay)
      setStatus(`Imported backup from ${file.name}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Import failed.')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  async function onImportCsv(file: File | undefined) {
    if (!file) return
    try {
      const result = await importPriceVolumeLeaderboardCsv(file)
      await writeBackup(result.marketDay)
      setMarketDay(result.marketDay)
      await refresh(result.marketDay)
      setStatus(
        `Imported ${result.rows} CSV row(s) for ${result.marketDay}.`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'CSV import failed.')
    } finally {
      if (csvImportRef.current) csvImportRef.current.value = ''
    }
  }

  async function onPickStoredDay(closeTime: string) {
    const day = marketDayFromCloseTime(closeTime)
    setMarketDay(day)
    await refresh(day)
  }

  async function onDeleteDay() {
    if (dayRows.length === 0) {
      setStatus(`No rows to delete for ${marketDay}.`)
      return
    }
    const ok = window.confirm(
      `Delete all ${dayRows.length} input row(s) for ${marketDay}?`,
    )
    if (!ok) return

    try {
      const removed = await deleteLeadersForClose(selectedClose)
      await writeBackup(marketDay)
      await refresh(marketDay)
      setStatus(`Deleted ${removed} row(s) for ${marketDay}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Delete failed.')
    }
  }

  async function onDeleteRow(row: LeaderRow) {
    const ok = window.confirm(
      `Remove ${row.label.toUpperCase()} from ${marketDay} list?`,
    )
    if (!ok) return

    try {
      await deleteLeader(row.id)
      await writeBackup(marketDay)
      await refresh(marketDay)
      setStatus(`Removed ${row.label.toUpperCase()} from ${marketDay}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Delete failed.')
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <p className="brand">matricsX</p>
        <h1>Daily vol-p leaders</h1>
        <p className="lede">
          Record the top 5 vol × price names for each market close. Live store is
          IndexedDB; dated JSON backups go under project <code>data/</code>.
        </p>
      </header>

      <form className="entry-form" onSubmit={onSubmit}>
        <label className="market-day">
          <span>Market day (close)</span>
          <input
            type="date"
            value={marketDay}
            onChange={(e) => {
              setMarketDay(e.target.value)
              void refresh(e.target.value)
            }}
            required
          />
        </label>

        <div className="entry-head">
          <span>Ticker</span>
          <span>Close</span>
          <span>Volume</span>
          <span>Vol-p</span>
        </div>

        {rows.map((row, index) => {
          const volp = calcVolPrice(row.close, row.volume)
          return (
            <div className="entry-row" key={index}>
              <label className="field">
                <span className="sr-only">Ticker {index + 1}</span>
                <TickerSearchInput
                  value={row.label}
                  options={tickerLabels}
                  onChange={(value) => updateRow(index, 'label', value)}
                />
              </label>
              <label className="field">
                <span className="sr-only">Close {index + 1}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="close"
                  value={row.close}
                  onChange={(e) => updateRow(index, 'close', e.target.value)}
                />
              </label>
              <label className="field">
                <span className="sr-only">Volume {index + 1}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="volume"
                  value={row.volume}
                  onChange={(e) => updateRow(index, 'volume', e.target.value)}
                />
              </label>
              <label className="field">
                <span className="sr-only">Vol-p {index + 1}</span>
                <input
                  className="volp-readonly"
                  type="text"
                  readOnly
                  tabIndex={-1}
                  placeholder="vol × price"
                  value={formatVolPrice(volp)}
                />
              </label>
            </div>
          )
        })}

        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save top 5 for close'}
          </button>
          {status ? <p className="status">{status}</p> : null}
        </div>

        <section className="prior-entry" aria-labelledby="subzone-heading">
          <h2 id="subzone-heading">Sub-zone (near top)</h2>
          <p className="backup-note">
            Names just outside the top 5 for this close — prior top-5 names, or
            first-time entrants into your sub-zone. Pool size is your rule (e.g.
            top 5+5, top 5+7, top 5+10). New tickers are fine; they are added to
            the ticker table on Add.
          </p>
          <div className="prior-row">
            <label className="field">
              <span className="sr-only">Sub-zone ticker</span>
              <TickerSearchInput
                value={priorPick}
                options={subzoneSuggestions}
                placeholder="Type new ticker or search"
                showAllWhenOpen
                maxSuggestions={20}
                onChange={setPriorPick}
              />
            </label>
            <label className="field">
              <span className="sr-only">Sub-zone close</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="close"
                value={priorClose}
                onChange={(e) => setPriorClose(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="sr-only">Sub-zone volume</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="volume"
                value={priorVolume}
                onChange={(e) => setPriorVolume(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="sr-only">Sub-zone vol-p</span>
              <input
                className="volp-readonly"
                type="text"
                readOnly
                tabIndex={-1}
                placeholder="vol × price"
                value={formatVolPrice(priorVolPrice)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => void addPriorToDayList()}
            >
              Add
            </button>
          </div>
        </section>
      </form>

      <section className="backup" aria-labelledby="backup-heading">
        <h2 id="backup-heading">Backup</h2>
        <p className="backup-note">
          {linked
            ? 'Data folder linked — exports write matricsx-backup_yyyy_mm_dd.json and prune by retention.'
            : 'Link the project data/ folder so dated JSON files are stored there (otherwise Export downloads).'}
        </p>
        <div className="retention-row">
          <label>
            <span>Keep backups (days)</span>
            <input
              type="number"
              min="0"
              step="1"
              value={retentionDays}
              onChange={(e) => setRetentionDaysState(Number(e.target.value))}
            />
          </label>
          <button type="button" className="secondary" onClick={() => void onApplyRetention()}>
            Apply / prune
          </button>
        </div>
        <div className="backup-actions">
          <button type="button" className="secondary" onClick={() => void onLinkFolder()}>
            Link data folder
          </button>
          <button type="button" className="secondary" disabled={!linked} onClick={() => void onExport()}>
            Export JSON
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!linked}
            onClick={() => importRef.current?.click()}
          >
            Import JSON
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => void onImportFile(e.target.files?.[0])}
          />
          <button
            type="button"
            className="secondary"
            disabled={!linked}
            onClick={() => csvImportRef.current?.click()}
          >
            Import leaderboard CSV
          </button>
          <input
            ref={csvImportRef}
            type="file"
            accept="text/csv,.csv"
            className="sr-only"
            onChange={(e) => void onImportCsv(e.target.files?.[0])}
          />
        </div>
      </section>

      <section className="leaderboard" aria-labelledby="leader-heading">
        <div className="leaderboard-head">
          <h2 id="leader-heading">All inputs @ {marketDay}</h2>
          <button
            type="button"
            className="danger"
            disabled={dayRows.length === 0}
            onClick={() => void onDeleteDay()}
          >
            Delete day
          </button>
        </div>
        <p className="backup-note">
          Day list sorted by vol-p. Edit close/volume then Apply — if both are
          blank, vol-p is kept. Delete removes a row from the list.
        </p>
        {closeTimes.length > 0 ? (
          <div className="day-chips" role="list">
            {closeTimes.map((closeTime) => {
              const day = marketDayFromCloseTime(closeTime)
              const active = closeTime === selectedClose
              return (
                <button
                  key={closeTime}
                  type="button"
                  role="listitem"
                  className={active ? 'day-chip active' : 'day-chip'}
                  onClick={() => void onPickStoredDay(closeTime)}
                >
                  {day}
                </button>
              )
            })}
          </div>
        ) : null}
        {dayRows.length === 0 ? (
          <p className="empty">No saved inputs for this day yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Ticker</th>
                <th scope="col">Close</th>
                <th scope="col">Volume</th>
                <th scope="col">Vol-p</th>
                <th scope="col">Source</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dayRows.map((row) => {
                const edit = dayEdits[row.id] ?? { close: '', volume: '' }
                return (
                  <tr key={row.id}>
                    <td>{row.rank}</td>
                    <td
                      className={
                        row.isNewTicker
                          ? `ticker ticker-new ${row.percentChange != null && row.percentChange > 0 ? 'up' : 'down'}`
                          : 'ticker'
                      }
                    >
                      {row.isNewTicker ? '*' : ''}{row.label}
                      {row.isNewTicker && typeof row.percentChange === 'number' ? (
                        <span className="ticker-change">
                          {' '}({formatPercentChange(row.percentChange)})
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <input
                        className="amend-num"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="close"
                        value={edit.close}
                        onChange={(e) =>
                          setDayEdits((prev) => ({
                            ...prev,
                            [row.id]: { ...edit, close: e.target.value },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="amend-num"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="volume"
                        value={edit.volume}
                        onChange={(e) =>
                          setDayEdits((prev) => ({
                            ...prev,
                            [row.id]: { ...edit, volume: e.target.value },
                          }))
                        }
                      />
                    </td>
                    <td className="num">{formatVolPrice(row.volprice)}</td>
                    <td>{row.source === 'top5' ? 'top 5' : 'sub-zone'}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-save"
                          onClick={() => void onApplyDayComponents(row)}
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          className="row-delete"
                          onClick={() => void onDeleteRow(row)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

export default App
