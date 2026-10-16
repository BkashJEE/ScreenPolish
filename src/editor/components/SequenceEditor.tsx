import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExportRequest, LoadedProject, LoadedSequence } from '../../shared/ipc'
import { syncEvents } from '../../shared/input-sync'
import { pointerPathFor } from '../../shared/pointer'
import {
  DEFAULT_SEQUENCE_TRANSITION,
  clipAtSequenceTime,
  moveClip,
  newClipId,
  placeClips,
  removeSequenceClip,
  setClipTransition,
  type Sequence
} from '../../shared/sequence'
import { takeOutput } from '../../shared/take-time'
import type { Project, RecordingSummary } from '../../shared/types'
import { resolveZoomSegments } from '../../shared/zoom-planner'
import { exportSequence } from '../lib/export-sequence'
import { baseName, loadImage, loadOverlayImages } from '../lib/media'
import { imageUrlForPath, normalizeProject } from '../lib/project'
import { formatTime, resolveTrim } from '../lib/time'
import { withCleanVoice } from '../lib/voice'
import { AppearancePicker } from './AppearancePicker'
import { Back, Export, Film, Pause, Play, Plus, Spinner, Warning, X } from './icons'
import { Preview } from './Preview'
import { Button, Chip, EmptyState, IconButton, Select, cx } from './ui'

/** requestIds already run in this window; survives StrictMode remounts. */
const handledRequests = new Set<string>()

interface TakeData {
  loaded: LoadedProject
  project: Project
  /** Seconds of the recording itself. */
  sourceSec: number
}

/**
 * A sequence: several takes in one export. Not a second editor: each clip is
 * a take, edited in the normal editor, and this screen only orders the clips,
 * trims where each starts and ends, and sets how each hands over to the next.
 * The preview plays through the clips, switching takes at each boundary.
 */
export function SequenceEditor({ folder, onBack, onOpenTake }: { folder: string; onBack: () => void; onOpenTake?: (folder: string) => void }) {
  const [loaded, setLoaded] = useState<LoadedSequence | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [takes, setTakes] = useState<Map<string, TakeData>>(() => new Map())
  const [library, setLibrary] = useState<RecordingSummary[]>([])

  const reload = useCallback(async () => {
    const [l, list] = await Promise.all([window.polish.sequenceLoad(folder), window.polish.list()])
    setLibrary(list)
    const durations = new Map(list.map((r) => [r.folder, r.durationSec ?? 0]))
    const map = new Map<string, TakeData>()
    for (const t of l.takes) {
      if (t.missing || map.has(t.take)) continue
      const take = await window.polish.load(t.folder)
      map.set(t.take, { loaded: take, project: normalizeProject(take.project), sourceSec: durations.get(t.folder) ?? 0 })
    }
    setTakes(map)
    setLoaded(l)
  }, [folder])

  useEffect(() => {
    setLoaded(null)
    setError(null)
    reload().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [reload])

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <Bar title={baseName(folder)} onBack={onBack} />
        <EmptyState icon={<Warning size={22} />} title="Could not open this sequence" body={error} action={<Button onClick={onBack}>Back to library</Button>} />
      </div>
    )
  }
  if (!loaded) {
    return (
      <div className="flex h-full flex-col">
        <Bar title={baseName(folder)} onBack={onBack} />
        <div className="flex flex-1 items-center justify-center text-fg-dim">
          <Spinner size={18} />
        </div>
      </div>
    )
  }
  return <LoadedSequenceEditor key={folder} loaded={loaded} takes={takes} library={library} onBack={onBack} onOpenTake={onOpenTake} onReload={() => void reload()} />
}

function LoadedSequenceEditor({
  loaded,
  takes,
  library,
  onBack,
  onOpenTake,
  onReload
}: {
  loaded: LoadedSequence
  takes: Map<string, TakeData>
  library: RecordingSummary[]
  onBack: () => void
  onOpenTake?: (folder: string) => void
  onReload: () => void
}) {
  const folder = loaded.folder
  const [sequence, setSequence] = useState<Sequence>(loaded.sequence)
  // A reload (a take added) brings a new sequence from disk.
  useEffect(() => setSequence(loaded.sequence), [loaded.sequence])
  const takeInfo = useMemo(() => new Map(loaded.takes.map((t) => [t.take, t])), [loaded.takes])
  const [index, setIndex] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState<{ fraction: number; label: string } | null>(null)
  const [result, setResult] = useState<{ path?: string; error?: string } | null>(null)
  const abort = useRef<AbortController | null>(null)

  // Every edit is saved at once; a sequence is a short list, and the takes keep their own saves.
  const update = (next: Sequence) => {
    setSequence(next)
    void window.polish.sequenceSave(folder, next).catch((e: unknown) => setResult({ error: e instanceof Error ? e.message : String(e) }))
  }

  const outputs = useMemo(
    () => sequence.clips.map((c) => {
      const t = takes.get(c.take)
      return t ? takeOutput(t.project, t.sourceSec) : null
    }),
    [sequence, takes]
  )
  const lengths = useMemo(() => outputs.map((o) => o?.lengthSec ?? 0), [outputs])
  const placed = useMemo(() => placeClips(sequence, lengths), [sequence, lengths])
  const total = placed.at(-1)?.end ?? 0
  const current = placed[index] ?? null
  const clip = sequence.clips[index]
  const take = clip ? takes.get(clip.take) ?? null : null
  const output = outputs[index] ?? null

  /** The recording time a clip's output second shows; a card shows the nearest recording frame. */
  const sourceAt = useCallback(
    (i: number, local: number): number => {
      const o = outputs[i]
      const t = takes.get(sequence.clips[i]?.take ?? '')
      if (!o || !t) return 0
      const frame = o.at(local)
      if (frame.kind === 'recording' && 'sourceSec' in frame) return frame.sourceSec
      const trim = resolveTrim(t.project.trim, t.sourceSec)
      return local < o.lengthSec / 2 ? trim.start : trim.end
    },
    [outputs, takes, sequence]
  )

  const sequenceTime = current && output ? current.start + Math.max(0, output.fromSource(sourceTime) - current.in) : 0

  // Going to another take mounts a new preview, which reports its first frame
  // before its video has loaded. Until it has, that report is ignored and the
  // wanted moment is kept, then sought to (the millisecond makes it a change
  // the preview acts on; it skips anything closer than a microsecond to what
  // it last reported).
  const pending = useRef<number | null>(null)
  const goTo = useCallback(
    (i: number, source: number) => {
      if (sequence.clips[i]?.take !== sequence.clips[index]?.take) pending.current = source
      setIndex(i)
      setSourceTime(source)
    },
    [sequence, index]
  )
  const onDuration = () => {
    const t = pending.current
    if (t === null) return
    pending.current = null
    setSourceTime(t + 1e-3)
  }

  const seek = useCallback(
    (t: number) => {
      const pos = clipAtSequenceTime(sequence, lengths, t)
      if (!pos) return
      goTo(pos.clipIndex, sourceAt(pos.clipIndex, pos.localTime))
    },
    [sequence, lengths, sourceAt, goTo]
  )

  // Keep the playhead on a clip that exists after an edit.
  useEffect(() => {
    if (index >= sequence.clips.length) setIndex(Math.max(0, sequence.clips.length - 1))
  }, [index, sequence.clips.length])

  // Start on the first clip's in point.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !placed.length) return
    started.current = true
    seek(0)
  }, [placed, seek])

  // Playback crosses into the next clip where it starts on the sequence clock:
  // at this clip's out point, or where a crossfade into the next begins. The
  // preview cuts there rather than fading; the export does the fade.
  const onTime = (t: number) => {
    if (pending.current !== null) return
    setSourceTime(t)
    if (!current || !output) return
    if (output.fromSource(t) >= current.out - current.overlapNext - 1 / 60) {
      const next = placed[index + 1]
      if (next) goTo(index + 1, sourceAt(index + 1, next.in))
      else setPlaying(false)
    }
  }

  // Background and image overlays of the take on screen.
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null)
  const [overlayImages, setOverlayImages] = useState<Map<string, CanvasImageSource>>(() => new Map())
  useEffect(() => {
    let alive = true
    const p = take?.project
    const path = p?.background.kind === 'image' ? p.background.imagePath : undefined
    if (path) loadImage(imageUrlForPath(path)).then((img) => alive && setBackgroundImage(img)).catch(() => alive && setBackgroundImage(null))
    else setBackgroundImage(null)
    if (p) void loadOverlayImages(p.overlays).then((m) => alive && setOverlayImages(m))
    return () => {
      alive = false
    }
  }, [take])

  const runExport = useCallback(
    async (name: string): Promise<string> => {
      const controller = new AbortController()
      abort.current = controller
      setResult(null)
      setExporting({ fraction: 0, label: 'Starting' })
      try {
        const latest = await window.polish.sequenceLoad(folder)
        const r = await exportSequence({ loaded: latest, name, signal: controller.signal, onProgress: (fraction, label) => setExporting({ fraction, label }) })
        setResult({ path: r.path })
        return r.path
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setResult({ error: message })
        throw e
      } finally {
        setExporting(null)
        abort.current = null
      }
    },
    [folder]
  )

  // Export requests from main (`polish export NAME`), as the take editor answers them.
  const exportRef = useRef(runExport)
  exportRef.current = runExport
  useEffect(() => {
    const run = async (req: ExportRequest) => {
      if (req.folder !== folder || handledRequests.has(req.requestId)) return
      handledRequests.add(req.requestId)
      if (req.kind !== 'mp4') {
        window.polish.exportRequestDone({ requestId: req.requestId, error: 'Sequences export MP4 for now.' })
        return
      }
      try {
        window.polish.exportRequestDone({ requestId: req.requestId, path: await exportRef.current(req.name) })
      } catch (e) {
        window.polish.exportRequestDone({ requestId: req.requestId, error: e instanceof Error ? e.message : String(e) })
      }
    }
    const off = window.polish.onExportRequest((req) => void run(req))
    void window.polish.pendingExport(folder).then((req) => req && run(req))
    return off
  }, [folder])

  const events = useMemo(() => (take ? syncEvents(take.loaded.events, take.project.cursor.syncSec) : null), [take])
  const segments = useMemo(() => (take && events ? resolveZoomSegments(take.project, events, take.sourceSec) : []), [take, events])
  const pointerPath = useMemo(() => (take && events ? pointerPathFor(events, take.project.cursor) : []), [take, events])
  const urls = useMemo(() => (take ? withCleanVoice(take.project, take.loaded.urls, take.loaded.urls.micClean) : null), [take])
  const trim = useMemo(() => (take ? resolveTrim(take.project.trim, take.sourceSec) : { start: 0, end: 0 }), [take])

  const addable = library.filter((r) => !r.sequence)
  const name = sequence.title || 'Sequence'

  return (
    <div className="flex h-full flex-col">
      <Bar
        title={sequence.title}
        onBack={onBack}
        onRename={(title) => update({ ...sequence, title })}
        right={
          exporting ? (
            <div className="flex items-center gap-2 text-[12px] text-fg-muted">
              <Spinner size={13} /> {exporting.label} · {Math.round(exporting.fraction * 100)}%
              <Button size="sm" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="primary" icon={<Export size={14} />} disabled={sequence.clips.length === 0 || placed.length === 0} onClick={() => void runExport(name).catch(() => undefined)}>
              Export MP4
            </Button>
          )
        }
      />
      {result && (
        <div className={cx('border-b border-line px-3 py-1.5 text-[12px]', result.error ? 'text-danger' : 'text-fg-muted')}>
          {result.error ?? (
            <>
              Exported{' '}
              <button type="button" className="underline hover:text-fg" onClick={() => void window.polish.reveal(result.path!)}>
                {result.path!.split(/[\\/]/).pop()}
              </button>
            </>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-bg-0">
        {take && urls && events ? (
          <Preview
            key={clip!.take}
            hideControls
            urls={urls}
            events={events}
            project={take.project}
            segments={segments}
            pointerPath={pointerPath}
            backgroundImage={backgroundImage}
            overlayImages={overlayImages}
            selectedOverlayId={null}
            duration={take.sourceSec}
            time={sourceTime}
            playing={playing}
            trim={trim}
            onTime={onTime}
            // The take being left can report its own end as it is swapped out; that is not a pause.
            onPlayingChange={(p) => (p || pending.current === null) && setPlaying(p)}
            onDuration={onDuration}
            onError={(m) => setResult({ error: m })}
            onSelectOverlay={() => undefined}
            onOverlayPatch={() => undefined}
            onFramePatch={() => undefined}
          />
        ) : (
          <EmptyState icon={<Film size={22} />} title={sequence.clips.length ? 'This take is missing' : 'No clips yet'} body={sequence.clips.length ? 'It is no longer in the recordings folder. Remove the clip, or put the take back.' : 'Add takes below.'} />
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-bg-1 px-3 py-2">
        <div className="flex items-center gap-2">
          <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </IconButton>
          <span className="font-mono text-[11.5px] tabular-nums text-fg-muted">
            {formatTime(sequenceTime)} / {formatTime(total)}
          </span>
          <input
            type="range"
            aria-label="Sequence playhead"
            className="min-w-0 flex-1 accent-[var(--color-accent,#f2804f)]"
            min={0}
            max={Math.max(0.01, total)}
            step={0.01}
            value={Math.min(total, sequenceTime)}
            onChange={(e) => {
              setPlaying(false)
              seek(Number(e.target.value))
            }}
          />
        </div>
        <ClipStrip
          sequence={sequence}
          placed={placed}
          takeInfo={takeInfo}
          current={index}
          onSelect={(i) => {
            setPlaying(false)
            goTo(i, sourceAt(i, placed[i]?.in ?? 0))
          }}
          onMove={(from, to) => update(moveClip(sequence, from, to))}
          onRemove={(i) => update(removeSequenceClip(sequence, i))}
          onTransition={(i, fade) => update(setClipTransition(sequence, i, fade ? DEFAULT_SEQUENCE_TRANSITION : { style: 'none', durationSec: DEFAULT_SEQUENCE_TRANSITION.durationSec }))}
          onOpenTake={onOpenTake}
        />
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {clip && current && output && (
            <>
              <span className="text-fg-muted">
                Clip {index + 1}: {formatTime(current.in)} – {formatTime(current.out)} of {formatTime(lengths[index] ?? 0)}
              </span>
              <Button size="sm" title="Start this clip at the playhead" onClick={() => update({ ...sequence, clips: sequence.clips.map((c, i) => (i === index ? { ...c, in: Math.min(output.fromSource(sourceTime), current.out - 0.5) } : c)) })}>
                In here
              </Button>
              <Button size="sm" title="End this clip at the playhead" onClick={() => update({ ...sequence, clips: sequence.clips.map((c, i) => (i === index ? { ...c, out: Math.max(output.fromSource(sourceTime), current.in + 0.5) } : c)) })}>
                Out here
              </Button>
              {(clip.in > 0 || clip.out !== null) && (
                <Button size="sm" onClick={() => update({ ...sequence, clips: sequence.clips.map((c, i) => (i === index ? { ...c, in: 0, out: null } : c)) })}>
                  Whole take
                </Button>
              )}
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Plus size={13} className="text-fg-muted" />
            <Select<string>
              ariaLabel="Add a take"
              className="w-[220px]"
              value=""
              onChange={(f) => {
                const name = f.split(/[\\/]/).pop()
                if (!name) return
                const next = { ...sequence, clips: [...sequence.clips, { id: newClipId(), kind: 'recording' as const, take: name, in: 0, out: null, transition: { ...DEFAULT_SEQUENCE_TRANSITION } }] }
                void window.polish.sequenceSave(folder, next).then(onReload)
              }}
              options={[{ value: '', label: 'Add a take…' }, ...addable.map((r) => ({ value: r.folder, label: r.title || r.name }))]}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** One block per clip, as wide as it runs, with the hand-over to the next between them. */
function ClipStrip({
  sequence,
  placed,
  takeInfo,
  current,
  onSelect,
  onMove,
  onRemove,
  onTransition,
  onOpenTake
}: {
  sequence: Sequence
  placed: ReturnType<typeof placeClips>
  takeInfo: Map<string, LoadedSequence['takes'][number]>
  current: number
  onSelect: (i: number) => void
  onMove: (from: number, to: number) => void
  onRemove: (i: number) => void
  onTransition: (i: number, fade: boolean) => void
  onOpenTake?: (folder: string) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  return (
    <ol className="flex min-h-[64px] items-stretch gap-1 overflow-x-auto" aria-label="Clips">
      {sequence.clips.map((clip, i) => {
        const p = placed[i]
        const info = takeInfo.get(clip.take)
        const len = p ? p.out - p.in : 0
        const fade = clip.transition?.style === 'dissolve'
        return (
          <li key={clip.id} className="flex items-stretch gap-1" style={{ flex: `${Math.max(1, len)} 0 120px` }}>
            <div
              role="button"
              tabIndex={0}
              draggable
              aria-label={`Clip ${i + 1}: ${info?.title || clip.take}`}
              aria-current={i === current}
              onClick={() => onSelect(i)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(i)}
              onDragStart={(e) => {
                setDragging(i)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragging !== null) onMove(dragging, i)
                setDragging(null)
              }}
              className={cx(
                'group relative flex min-w-0 flex-1 cursor-pointer flex-col justify-end overflow-hidden rounded-[8px] border bg-bg-2 bg-cover bg-center px-2 py-1 text-left',
                i === current ? 'border-accent ring-1 ring-accent' : 'border-line-strong',
                info?.missing && 'border-danger'
              )}
              style={info?.thumbnail ? { backgroundImage: `linear-gradient(transparent 30%, rgba(0,0,0,.75)), url("${info.thumbnail}")` } : undefined}
            >
              <span className="truncate text-[11.5px] font-medium text-white">{info?.missing ? `Missing: ${clip.take}` : info?.title || clip.take}</span>
              <span className="font-mono text-[10.5px] tabular-nums text-white/75">{formatTime(len)}</span>
              <span className="absolute right-1 top-1 hidden gap-1 group-hover:flex group-focus-within:flex">
                {onOpenTake && info && !info.missing && (
                  <button type="button" className="rounded-[5px] bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-black/80" onClick={(e) => { e.stopPropagation(); onOpenTake(info.folder) }}>
                    Edit take
                  </button>
                )}
                <button type="button" aria-label={`Remove clip ${i + 1}`} className="rounded-[5px] bg-black/60 p-0.5 text-white hover:bg-black/80" onClick={(e) => { e.stopPropagation(); onRemove(i) }}>
                  <X size={12} />
                </button>
              </span>
            </div>
            {i < sequence.clips.length - 1 && (
              <button
                type="button"
                className={cx('w-9 shrink-0 rounded-[6px] border text-[10px] leading-tight', fade ? 'border-accent text-fg' : 'border-line-strong text-fg-dim hover:text-fg')}
                title={fade ? `Crossfade ${clip.transition?.durationSec ?? 0.5}s into the next clip. Click for a hard cut.` : 'Hard cut into the next clip. Click for a crossfade.'}
                aria-pressed={fade}
                onClick={() => onTransition(i, !fade)}
              >
                {fade ? 'Fade' : 'Cut'}
              </button>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Bar({ title, onBack, onRename, right }: { title: string; onBack: () => void; onRename?: (title: string) => void; right?: React.ReactNode }) {
  return (
    <div className="studio-topbar editor-topbar flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-2">
      <IconButton label="Back to library" onClick={onBack}>
        <Back size={15} />
      </IconButton>
      <Chip tone="info">Sequence</Chip>
      {onRename ? (
        <input
          aria-label="Sequence name"
          className="min-w-0 flex-1 basis-[280px] max-w-[420px] truncate rounded-[6px] border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] font-medium text-fg outline-none hover:border-line focus:border-accent focus:bg-bg-0"
          value={title}
          placeholder="Name this sequence"
          spellCheck={false}
          onChange={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
        />
      ) : (
        <div className="min-w-0 truncate text-[13px] font-medium text-fg">{title}</div>
      )}
      <div className="editor-actions ml-auto flex items-center gap-2">
        <AppearancePicker />
        {right}
      </div>
    </div>
  )
}
