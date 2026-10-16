import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RecordingSummary } from '../../shared/types'
import { imageUrlForPath } from '../lib/project'
import { formatDurationShort } from '../lib/time'
import type { AppSettings } from '../../shared/ipc'
import { Film, Folder, Refresh, Spinner, Trash, Warning } from './icons'
import { Button, Count, EmptyState, IconButton, cx } from './ui'
import { LibraryPreview } from './LibraryPreview'
import { PREVIEW_CLOSE_GRACE_MS, previewOpenDelay } from '../lib/hover-preview'

export const LIBRARY_CARD_SIZE_KEY = 'polish.library.card-size.v1'
export const LIBRARY_CARD_SIZE_DEFAULT = 220
export const LIBRARY_CARD_SIZE_MIN = 180
export const LIBRARY_CARD_SIZE_MAX = 360

export function normalizeLibraryCardSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return LIBRARY_CARD_SIZE_DEFAULT
  return Math.round(Math.max(LIBRARY_CARD_SIZE_MIN, Math.min(LIBRARY_CARD_SIZE_MAX, parsed)))
}

export function loadLibraryCardSize(storage?: Pick<Storage, 'getItem'>): number {
  try {
    // Resolve localStorage inside the guard: restricted contexts can throw while
    // reading the property itself, before getItem has a chance to run.
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    const raw = source?.getItem(LIBRARY_CARD_SIZE_KEY)
    return normalizeLibraryCardSize(raw === null || raw === undefined ? undefined : JSON.parse(raw))
  } catch {
    return LIBRARY_CARD_SIZE_DEFAULT
  }
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Hover preview: which card, and where across it the pointer is (0..1) for scrubbing. */
type Hover = { item: RecordingSummary; scrub: number | null }

export interface PreviewHandlers {
  enter: (item: RecordingSummary, e: ReactPointerEvent) => void
  move: (e: ReactPointerEvent) => void
  leave: () => void
}

function useHoverPreview(): { hover: Hover | null; handlers: PreviewHandlers; close: () => void } {
  const [hover, setHover] = useState<Hover | null>(null)
  const timer = useRef<number | null>(null)
  const showing = useRef(false)
  showing.current = hover !== null
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const close = useCallback(() => {
    clear()
    setHover(null)
  }, [])
  useEffect(() => clear, [])
  const fraction = (e: ReactPointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return r.width > 0 ? (e.clientX - r.left) / r.width : null
  }
  const handlers: PreviewHandlers = {
    enter: (item, e) => {
      // Touch and pen have no hover; a tap should just open the recording.
      if (e.pointerType !== 'mouse' || !item.preview) return
      clear()
      const delay = previewOpenDelay(showing.current)
      const open = () => setHover({ item, scrub: null })
      if (delay === 0) open()
      else timer.current = window.setTimeout(open, delay)
    },
    move: (e) => {
      if (e.pointerType !== 'mouse') return
      const f = fraction(e)
      setHover((h) => (h ? { ...h, scrub: f } : h))
    },
    leave: () => {
      clear()
      timer.current = window.setTimeout(() => setHover(null), PREVIEW_CLOSE_GRACE_MS)
    }
  }
  return { hover, handlers, close }
}

export function Library({ onOpen, refreshKey }: { onOpen: (folder: string) => void; refreshKey: number }) {
  const [items, setItems] = useState<RecordingSummary[] | null>(null)
  const preview = useHoverPreview()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [cardSize, setCardSize] = useState(loadLibraryCardSize)
  // Making a sequence: the takes picked so far, in the order they will play; null when not picking.
  const [picking, setPicking] = useState<string[] | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const list = await window.polish.list()
      setItems([...list].sort((a, b) => b.createdAt - a.createdAt))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    void window.polish.getSettings().then(setSettings).catch(() => setSettings(null))
  }, [refreshKey])

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_CARD_SIZE_KEY, JSON.stringify(cardSize))
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }, [cardSize])

  const changeFolder = async () => {
    const next = await window.polish.chooseRecordingsRoot()
    if (next) {
      setSettings(next)
      void load()
    }
  }

  const remove = async (folder: string) => {
    await window.polish.deleteRecording(folder)
    setItems((prev) => (prev ? prev.filter((i) => i.folder !== folder) : prev))
  }

  return (
    <div className="recordings-library flex h-full min-w-0 flex-1 flex-col max-[760px]:w-full">
      <div className="library-toolbar flex min-h-14 shrink-0 flex-wrap items-center gap-3 px-5 py-3">
        <h1 className="text-[13.5px] font-semibold text-fg">Recordings</h1>
        {items && <Count>{items.length}</Count>}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">

          {settings && (
            <button
              type="button"
              className="flex min-w-0 max-w-[420px] items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11.5px] text-fg-muted hover:bg-bg-2 hover:text-fg"
              title={`Recordings are saved in ${settings.recordingsRoot}. Click to change the folder.`}
              onClick={() => void changeFolder()}
            >
              <Folder size={13} className="shrink-0" />
              <span className="truncate font-mono">{settings.recordingsRoot}</span>
              <span className="shrink-0 text-fg-dim">Change</span>
            </button>
          )}
          <Button
            size="sm"
            disabled={picking !== null || !items || items.filter((i) => !i.sequence).length < 2}
            title="One video from several takes, one after another"
            onClick={() => setPicking([])}
          >
            Make a sequence
          </Button>
          <Button
            size="sm"
            disabled={importing}
            title="Edit a video made elsewhere: OBS, a phone, another recorder"
            onClick={() => {
              setImporting(true)
              void window.polish
                .importVideo()
                .then((folder) => {
                  if (folder) onOpen(folder)
                })
                .catch((e: unknown) => window.alert(`Could not open the video: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`))
                .finally(() => setImporting(false))
            }}
          >
            {importing ? <Spinner size={12} /> : null}
            {importing ? 'Opening…' : 'Open a video'}
          </Button>
          <IconButton label="Open recordings folder" onClick={() => void window.polish.openRecordingsRoot()}>
            <Folder size={14} />
          </IconButton>
          <IconButton label="Refresh" onClick={() => void load()} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Refresh size={14} />}
          </IconButton>
          <label className="library-size-control flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted" title="Adjust recording card size">
            <span>Card size</span>
            <input
              id="library-card-size"
              aria-label="Recording card size"
              type="range"
              min={LIBRARY_CARD_SIZE_MIN}
              max={LIBRARY_CARD_SIZE_MAX}
              step="10"
              value={cardSize}
              onChange={(event) => setCardSize(normalizeLibraryCardSize(event.target.value))}
              className="slider library-size-slider"
              style={{ ['--fill' as string]: `${((cardSize - LIBRARY_CARD_SIZE_MIN) / (LIBRARY_CARD_SIZE_MAX - LIBRARY_CARD_SIZE_MIN)) * 100}%` }}
            />
            <output className="w-9 text-right font-mono tabular-nums" htmlFor="library-card-size">{cardSize}px</output>
          </label>
        </div>
      </div>

      {/* Scrolling moves a card out from under a still pointer without a
          pointerleave, so a scroll closes the preview. */}
      {picking && (
        <div className="mx-5 mb-1 flex flex-wrap items-center gap-2 rounded-[8px] border border-accent/40 bg-bg-2 px-3 py-2 text-[12px]" role="status">
          <span className="text-fg">Pick takes in the order they should play.</span>
          <span className="text-fg-muted">{picking.length} picked</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPicking(null)} disabled={creating}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={picking.length < 2 || creating}
              icon={creating ? <Spinner size={12} /> : undefined}
              onClick={() => {
                setCreating(true)
                void window.polish
                  .sequenceCreate(picking)
                  .then((folder) => {
                    setPicking(null)
                    onOpen(folder)
                  })
                  .catch((e: unknown) => window.alert(`Could not make the sequence: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`))
                  .finally(() => setCreating(false))
              }}
            >
              Make sequence
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-5" onScroll={preview.close}>
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
            <Warning size={14} />
            {error}
          </div>
        )}
        {items === null && !error && (
          <div className="flex h-full items-center justify-center text-fg-dim">
            <Spinner size={18} />
          </div>
        )}
        {items && items.length === 0 && (
          <EmptyState
            icon={<Film size={22} />}
            title="No recordings yet"
            body={`Pick a source on the left and press Record. Recordings land in ${settings?.recordingsRoot ?? "your recordings folder"} and show up here. Click the folder path above to change it.`}
          />
        )}
        {items && items.length > 0 && (
          <div className="library-card-grid grid gap-5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${cardSize}px, 100%), 1fr))` }}>
            {items.map((item) => {
              const order = picking ? picking.indexOf(item.folder) : -1
              return (
                <RecordingCard
                  key={item.folder}
                  item={item}
                  picked={picking ? (order >= 0 ? order + 1 : 0) : null}
                  onOpen={() => {
                    preview.close()
                    if (!picking) return onOpen(item.folder)
                    if (item.sequence) return
                    setPicking(order >= 0 ? picking.filter((f) => f !== item.folder) : [...picking, item.folder])
                  }}
                  onDelete={() => remove(item.folder)}
                  // A sequence has no picture of its own to scrub.
                  preview={item.sequence || picking ? undefined : preview.handlers}
                />
              )
            })}
          </div>
        )}
      </div>
      {preview.hover && <LibraryPreview item={preview.hover.item} scrub={preview.hover.scrub} />}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function RecordingCard({ item, onOpen, onDelete, preview, picked = null }: { item: RecordingSummary; onOpen: () => void; onDelete: () => Promise<void>; preview?: PreviewHandlers; /** While making a sequence: this take's place in it (1-based), 0 when not picked; null when not picking. */ picked?: number | null }) {
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [broken, setBroken] = useState(false)
  const thumb = item.thumbnail && !broken ? imageUrlForPath(item.thumbnail) : null

  return (
    <div
      className={cx(
        'library-recording-card group relative flex flex-col overflow-hidden',
        confirm && 'is-confirming'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={confirm}
        className={cx('relative aspect-video w-full overflow-hidden bg-bg-2 text-left', picked !== null && item.sequence && 'opacity-40', picked ? 'ring-2 ring-inset ring-accent' : '')}
        aria-label={picked !== null ? `${picked ? 'Unpick' : 'Pick'} ${item.name}` : `Open ${item.name}`}
        aria-pressed={picked !== null ? picked > 0 : undefined}
        onPointerEnter={(e) => !confirm && preview?.enter(item, e)}
        onPointerMove={(e) => preview?.move(e)}
        onPointerLeave={() => preview?.leave()}
      >
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <div className="library-thumbnail-placeholder flex h-full w-full items-center justify-center text-fg-muted">
            <Film size={24} />
          </div>
        )}
        {item.sequence ? (
          <span className="library-duration absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/75 px-2 py-1 text-[10.5px] text-white" title="A sequence of takes">
            <SequenceIcon /> {item.sequence.clips} {item.sequence.clips === 1 ? 'clip' : 'clips'}
          </span>
        ) : (
          <span className="library-duration absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 font-mono text-[10.5px] tabular-nums text-white">
            {formatDurationShort(item.durationSec)}
          </span>
        )}
        {picked ? (
          <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-white">{picked}</span>
        ) : null}
      </button>

      <div className="rc-meta flex items-center gap-2 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-fg" title={item.title ? `${item.title} (${item.name})` : item.name}>
            {item.title || item.name}
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">
            {formatDate(item.createdAt)}
            {item.sizeBytes !== undefined && <span> · {formatBytes(item.sizeBytes)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label="Reveal in folder" size={26} onClick={() => void window.polish.reveal(item.folder)}>
            <Folder size={14} />
          </IconButton>
          <IconButton label="Delete" size={26} tone="danger" onClick={() => setConfirm(true)}>
            <Trash size={14} />
          </IconButton>
        </div>
      </div>

      {confirm && (
        <div className="fade-in absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-1/95 p-3 text-center">
          <div className="text-[12.5px] font-medium text-fg">{item.sequence ? 'Delete this sequence?' : 'Delete this recording?'}</div>
          <div className="text-[11.5px] text-fg-muted">{item.sequence ? 'Its exports are removed; the takes it uses stay.' : 'The folder and every file in it are removed.'}</div>
          <div className="mt-1 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={deleting} autoFocus>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={deleting}
              icon={deleting ? <Spinner size={12} /> : <Trash size={12} />}
              onClick={async () => {
                setDeleting(true)
                try {
                  await onDelete()
                } finally {
                  setDeleting(false)
                  setConfirm(false)
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Stacked frames: a sequence of takes. */
function SequenceIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.5" y="5.5" width="10" height="8" rx="1.5" />
      <path d="M4.5 3.5h8a1.5 1.5 0 0 1 1.5 1.5v6" />
    </svg>
  )
}
