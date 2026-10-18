import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { withCleanVoice } from '../lib/voice'
import { syncEvents } from '../../shared/input-sync'
import { canSplitAt, clipsFrom, keptDuration, removeClip, restoreClip, splitAt } from '../../shared/cuts'
import { clipSpeed, setClipSpeed, speedSpans } from '../../shared/speed'
import { RegionLanes } from './RegionLanes'
import type { ExportRequest, LoadedProject } from '../../shared/ipc'
import type { MockupKind, Overlay, OverlayKind, Project, ZoomSegment } from '../../shared/types'
import { outputSize } from '../../shared/layout'
import { pointerAt, pointerPathFor } from '../../shared/pointer'
import { resolveZoomSegments } from '../../shared/zoom-planner'
import { useDebouncedSave, type SaveStatus } from '../hooks/useDebouncedSave'
import { useKeyboard } from '../hooks/useKeyboard'
import { useProjectHistory } from '../hooks/useProjectHistory'
import { baseName, loadImage, loadOverlayImages } from '../lib/media'
import { addOverlay, createOverlay, duplicateOverlay, removeOverlay, updateOverlay, type OverlayPatch } from '../lib/overlays'
import { imageUrlForPath, normalizeProject } from '../lib/project'
import { addManualSegment, createManualSegment, removeSegment, restoreAutoSegments, updateSegment, type SegmentPatch } from '../lib/segments'
import { canonicalTrimEnd, clamp, frameDuration, resolveTrim } from '../lib/time'
import { ExportSheet } from './ExportSheet'
import { exportProject } from '../lib/export'
import { Back, Export, Redo, Region, Snapshot, Spinner, Undo, Warning } from './icons'
import { Knobs } from './Knobs'
import { AppearancePicker } from './AppearancePicker'
import { CropEditor } from './CropEditor'
import { Overlays } from './Overlays'
import { Preview } from './Preview'
import { ScrubBar } from './ScrubBar'
import { ThumbnailSheet } from './ThumbnailSheet'
import { Transport } from './Transport'
import { Button, Chip, EmptyState, IconButton, Kbd, cx, type ChipTone } from './ui'

/** requestIds already run in this window; survives StrictMode remounts. */
const handledExportRequests = new Set<string>()

function projectForDevPreview(project: Project): Project {
  if (!import.meta.env.DEV) return project
  const params = new URLSearchParams(location.search)
  const kind = params.get('mockup')
  const height = Number(params.get('height'))
  const backgroundKind = params.get('background')
  const colorParam = params.get('color')
  const solidColor = colorParam && /^[0-9a-f]{6}$/i.test(colorParam.replace(/^#/, '')) ? `#${colorParam.replace(/^#/, '')}` : '#39445f'
  const nextKind = kind === 'browser' || kind === 'macos' || kind === 'phone' || kind === 'laptop' || kind === 'none' ? (kind as MockupKind) : project.mockup.kind
  const nextHeight = height === 720 || height === 1080 || height === 1440 || height === 2160 ? height : project.output.height
  const nextBackground = backgroundKind === 'solid' ? { ...project.background, kind: 'solid' as const, colors: [solidColor], angle: 0 } : project.background
  if (nextKind === project.mockup.kind && nextHeight === project.output.height && nextBackground === project.background) return project
  return { ...project, background: nextBackground, mockup: { ...project.mockup, kind: nextKind }, output: { ...project.output, height: nextHeight } }
}

export function Editor({ folder, onBack }: { folder: string; onBack: () => void }) {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoaded(null)
    setError(null)
    window.polish
      .load(folder)
      .then((l) => alive && setLoaded({ ...l, project: projectForDevPreview(normalizeProject(l.project)) }))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [folder])

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <TopBar name={baseName(folder)} onBack={onBack} />
        <EmptyState icon={<Warning size={22} />} title="Could not open this recording" body={error} action={<Button onClick={onBack}>Back to library</Button>} />
      </div>
    )
  }
  if (!loaded) {
    return (
      <div className="flex h-full flex-col">
        <TopBar name={baseName(folder)} onBack={onBack} />
        <div className="flex flex-1 items-center justify-center text-fg-dim">
          <Spinner size={18} />
        </div>
      </div>
    )
  }
  return <LoadedEditor key={folder} loaded={loaded} onBack={onBack} />
}

function TopBar({ name, onBack, status, right, onRename }: { name: string; onBack: () => void; status?: SaveStatus; right?: React.ReactNode; onRename?: (title: string) => void }) {
  const statusText: Record<SaveStatus, string> = { clean: '', dirty: 'Unsaved', saving: 'Saving', saved: 'Saved', error: 'Save failed' }
  const statusTone: Record<SaveStatus, ChipTone> = { clean: 'idle', dirty: 'warn', saving: 'idle', saved: 'ok', error: 'danger' }
  return (
    <div className="studio-topbar editor-topbar flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-2">
      <IconButton label="Back to library" onClick={onBack}>
        <Back size={15} />
      </IconButton>
      {onRename ? (
        <input
          aria-label="Recording title"
          className="min-w-0 flex-1 basis-[280px] max-w-[420px] truncate rounded-[6px] border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] font-medium text-fg outline-none hover:border-line focus:border-accent focus:bg-bg-0"
          value={name}
          spellCheck={false}
          onChange={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          title="Click to rename"
        />
      ) : (
        <div className="min-w-0 truncate text-[13px] font-medium text-fg" title={name}>
          {name}
        </div>
      )}
      {status && statusText[status] && <Chip tone={statusTone[status]}>{statusText[status]}</Chip>}
      <div className="editor-actions ml-auto flex items-center gap-2"><AppearancePicker />{right}</div>
    </div>
  )
}

function LoadedEditor({ loaded, onBack }: { loaded: LoadedProject; onBack: () => void }) {
  const { events: recordedEvents, files, urls } = loaded
  const folder = files.folder
  const { project, setProject, undo, redo, canUndo, canRedo, beginBatch, endBatch } = useProjectHistory(loaded.project)
  // Click timing moves the whole input log against the picture; everything below uses the moved log.
  const events = useMemo(() => syncEvents(recordedEvents, project.cursor.syncSec), [recordedEvents, project.cursor.syncSec])
  const clickTimes = useMemo(() => events.clicks.filter((c) => c.down).map((c) => c.t / 1000), [events])
  // When each step of a guided take began, from the recording guide's marks.
  const stepMarks = useMemo(() => (recordedEvents.steps ? recordedEvents.steps.map((t) => t / 1000) : undefined), [recordedEvents])
  // Clean up voice swaps the microphone for its cleaned copy everywhere it is played or exported.
  const [cleanMicUrl, setCleanMicUrl] = useState(urls.micClean)
  const media = useMemo(() => withCleanVoice(project, urls, cleanMicUrl), [project, urls, cleanMicUrl])
  const mediaLoaded = useMemo(() => ({ ...loaded, urls: media }), [loaded, media])
  const [duration, setDuration] = useState<number>(NaN)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null)
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [thumbnailOpen, setThumbnailOpen] = useState(false)
  const [cropOpen, setCropOpen] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null)
  const [overlayImages, setOverlayImages] = useState<Map<string, CanvasImageSource>>(() => new Map())

  const saveStatus = useDebouncedSave(folder, project, loaded.project)
  const onProject = useCallback((update: (p: Project) => Project) => setProject((p) => update(p)), [])

  const hasDuration = Number.isFinite(duration) && duration > 0
  const trim = useMemo(() => resolveTrim(project.trim, hasDuration ? duration : 0), [project.trim, duration, hasDuration])
  const segments = useMemo(() => (hasDuration ? resolveZoomSegments(project, events, duration) : []), [project, events, duration, hasDuration])
  const pointerPath = useMemo(() => pointerPathFor(events, project.cursor), [events, project.cursor.smoothing, project.cursor.glide])
  const videoSize = useMemo(() => ({ width: events.region.width, height: events.region.height }), [events.region])
  const outSize = useMemo(() => outputSize(project, videoSize), [project, videoSize])
  const selected = useMemo(() => segments.find((s) => s.id === selectedZoomId) ?? null, [segments, selectedZoomId])
  const fps = project.output.fps

  // Background image follows the project's imagePath.
  useEffect(() => {
    const path = project.background.kind === 'image' ? project.background.imagePath : undefined
    if (!path) {
      setBackgroundImage(null)
      return
    }
    let alive = true
    loadImage(imageUrlForPath(path))
      .then((img) => alive && setBackgroundImage(img))
      .catch(() => alive && setBackgroundImage(null))
    return () => {
      alive = false
    }
  }, [project.background.kind, project.background.imagePath])

  // Image overlays are decoded once and shared by preview, thumbnail and export.
  useEffect(() => {
    let alive = true
    void loadOverlayImages(project.overlays, overlayImages).then((images) => {
      if (alive) setOverlayImages(images)
    })
    return () => {
      alive = false
    }
    // The current map is deliberately reused without making it an effect input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.overlays])

  const selectZoom = useCallback((id: string | null) => {
    setSelectedZoomId(id)
    if (id) { setSelectedOverlayId(null); setSelectedClipId(null) }
  }, [])

  const selectOverlay = useCallback((id: string | null) => {
    setSelectedOverlayId(id)
    if (id) { setSelectedZoomId(null); setSelectedClipId(null) }
  }, [])

  const selectClip = useCallback((id: string | null) => {
    setSelectedClipId(id)
    if (id) { setSelectedZoomId(null); setSelectedOverlayId(null) }
  }, [])

  // Export requests from main (`polish export`, `polish clip --export`) and the
  // dev-only ?autoexport=mp4|gif query. Deduped by requestId across StrictMode
  // double-mounts; the project used is whatever is current when the request lands.
  const projectRef = useRef(project)
  projectRef.current = project
  useEffect(() => {
    const run = async (req: ExportRequest): Promise<void> => {
      if (req.folder !== folder || handledExportRequests.has(req.requestId)) return
      handledExportRequests.add(req.requestId)
      const started = performance.now()
      try {
        const r = await exportProject({
          folder,
          urls,
          events,
          project: projectRef.current,
          kind: req.kind,
          name: req.name,
          onProgress: () => undefined,
          signal: new AbortController().signal
        })
        console.log(`[autoexport] done ${r.path} in ${((performance.now() - started) / 1000).toFixed(1)}s`)
        window.polish.exportRequestDone({ requestId: req.requestId, path: r.path })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error(`[autoexport] error ${message}`)
        window.polish.exportRequestDone({ requestId: req.requestId, error: message })
      }
    }
    const off = window.polish.onExportRequest((req) => void run(req))
    void window.polish.pendingExport(folder).then((req) => req && run(req))
    if (import.meta.env.DEV) {
      const kind = new URLSearchParams(location.search).get('autoexport')
      if (kind === 'mp4' || kind === 'gif') void run({ requestId: `autoexport-${folder}`, folder, kind, name: `autoexport-${kind}` })
    }
    return off
  }, [folder, urls, events])

  // Start on the trim start once the duration is known.
  useEffect(() => {
    if (hasDuration) setTime((t) => clamp(t, trim.start, trim.end))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDuration])

  const seek = useCallback(
    (t: number) => {
      if (!hasDuration) return
      setTime(clamp(t, 0, duration))
    },
    [duration, hasDuration]
  )

  const togglePlay = useCallback(() => {
    if (!hasDuration) return
    if (playing) {
      setPlaying(false)
      return
    }
    if (time >= trim.end - 0.02 || time < trim.start) setTime(trim.start)
    setPlaying(true)
  }, [hasDuration, playing, time, trim])

  const setTrim = useCallback(
    (next: { start: number; end: number }) => {
      if (!hasDuration) return
      const start = clamp(next.start, 0, duration)
      const end = clamp(next.end, start, duration)
      onProject((p) => ({ ...p, trim: { start, end: canonicalTrimEnd(end, duration) } }))
    },
    [duration, hasDuration, onProject]
  )

  // Clip slicer: splits divide the trim into clips; removed clips become cuts.
  const clips = useMemo(() => clipsFrom(trim, project.splits, project.cuts), [trim, project.splits, project.cuts])
  const selectedClip = useMemo(() => clips.find((c) => c.id === selectedClipId) ?? null, [clips, selectedClipId])
  // What the export will run: trims, removed clips and speed changes all count,
  // so speeding a clip up shows its saving straight away.
  const keptSeconds = useMemo(() => speedSpans(trim.start, trim.end, project.speedRegions, project.cuts).at(-1)?.outputEnd ?? keptDuration(trim.start, trim.end, project.cuts), [trim, project.cuts, project.speedRegions])
  const canSplit = hasDuration && canSplitAt(time, project.splits, trim)

  const splitAtPlayhead = useCallback(() => {
    if (!hasDuration || !canSplitAt(time, project.splits, trim)) return false
    const splits = splitAt(time, project.splits, trim)
    onProject((p) => ({ ...p, splits }))
    // Select the clip that starts here, so Delete right after removes it.
    selectClip(`clip-${Math.round(time * 1000)}`)
  }, [hasDuration, onProject, project.splits, selectClip, time, trim])

  const removeSelectedClip = useCallback(() => {
    if (!selectedClip || selectedClip.removed) return false
    if (clips.filter((c) => !c.removed).length <= 1) return false
    onProject((p) => ({ ...p, cuts: removeClip(selectedClip, p.cuts) }))
  }, [clips, onProject, selectedClip])

  // CapCut-style: split, select a piece, pick a speed for exactly that piece.
  const setSelectedClipSpeed = useCallback((rate: number) => {
    if (!selectedClip || selectedClip.removed) return
    onProject((p) => ({ ...p, speedRegions: setClipSpeed(p.speedRegions, selectedClip, rate) }))
  }, [onProject, selectedClip])

  const restoreSelectedClip = useCallback(() => {
    if (!selectedClip?.removed) return false
    onProject((p) => ({ ...p, cuts: restoreClip(selectedClip, p.cuts) }))
  }, [onProject, selectedClip])

  const setIn = useCallback(() => setTrim({ start: Math.min(time, trim.end - 0.2), end: trim.end }), [setTrim, time, trim.end])
  const setOut = useCallback(() => setTrim({ start: trim.start, end: Math.max(time, trim.start + 0.2) }), [setTrim, time, trim.start])

  const addSegmentAt = useCallback(
    (t: number) => {
      if (!hasDuration) return
      const seg = createManualSegment({ t, duration, focus: pointerAt(events, t), region: events.region, scale: project.zoom.scale })
      onProject((p) => addManualSegment(p, seg))
      selectZoom(seg.id)
      if (!project.zoom.enabled) onProject((p) => ({ ...p, zoom: { ...p.zoom, enabled: true } }))
      seek(t)
    },
    [duration, events, hasDuration, onProject, project.zoom.enabled, project.zoom.scale, seek, selectZoom]
  )

  const patchSegment = useCallback(
    (segment: ZoomSegment, patch: SegmentPatch): ZoomSegment => {
      const result = updateSegment(project, segment, patch, duration)
      setProject(result.project)
      selectZoom(result.segment.id)
      return result.segment
    },
    [project, duration, selectZoom]
  )

  const deleteSegment = useCallback(
    (segment: ZoomSegment) => {
      onProject((p) => removeSegment(p, segment))
      setSelectedZoomId(null)
    },
    [onProject]
  )

  const addOverlayAtPlayhead = useCallback(
    (kind: OverlayKind, content: string) => {
      const overlay = createOverlay({ kind, content, t: time, duration })
      onProject((p) => addOverlay(p, overlay))
      selectOverlay(overlay.id)
    },
    [duration, onProject, selectOverlay, time]
  )

  const patchOverlay = useCallback(
    (id: string, patch: OverlayPatch) => {
      onProject((p) => updateOverlay(p, id, patch))
      selectOverlay(id)
    },
    [onProject, selectOverlay]
  )

  const patchFrame = useCallback(
    (patch: { offsetX: number; offsetY: number }) => {
      onProject((p) => ({ ...p, frame: { ...p.frame, ...patch } }))
    },
    [onProject]
  )

  const deleteOverlay = useCallback(
    (id: string) => {
      onProject((p) => removeOverlay(p, id))
      setSelectedOverlayId((selected) => (selected === id ? null : selected))
    },
    [onProject]
  )

  const copyOverlay = useCallback(
    (id: string) => {
      const source = project.overlays.find((o) => o.id === id)
      if (!source) return
      const copy = duplicateOverlay(source)
      onProject((p) => addOverlay(p, copy))
      selectOverlay(copy.id)
    },
    [onProject, project.overlays, selectOverlay]
  )

  const selectedOverlay = useMemo<Overlay | null>(() => project.overlays.find((o) => o.id === selectedOverlayId) ?? null, [project.overlays, selectedOverlayId])

  useKeyboard(
    {
      Space: togglePlay,
      ArrowLeft: () => seek(time - frameDuration(fps)),
      ArrowRight: () => seek(time + frameDuration(fps)),
      'Shift+ArrowLeft': () => seek(time - 1),
      'Shift+ArrowRight': () => seek(time + 1),
      Home: () => seek(trim.start),
      End: () => seek(trim.end),
      i: setIn,
      o: setOut,
      s: splitAtPlayhead,
      Delete: () => (selectedOverlay ? deleteOverlay(selectedOverlay.id) : selected ? deleteSegment(selected) : selectedClip ? removeSelectedClip() : false),
      Backspace: () => (selectedOverlay ? deleteOverlay(selectedOverlay.id) : selected ? deleteSegment(selected) : selectedClip ? removeSelectedClip() : false),
      'Ctrl+z': undo,
      'Ctrl+Shift+z': redo,
      'Ctrl+y': redo,
      'Ctrl+e': () => setExportOpen(true),
      Escape: () => {
        if (exportOpen) return false
        if (selectedOverlayId) setSelectedOverlayId(null)
        else if (selectedZoomId) setSelectedZoomId(null)
        else if (selectedClipId) setSelectedClipId(null)
        else return false
      }
    },
    { enabled: !exportOpen && !thumbnailOpen, always: ['Ctrl+e'] }
  )

  const name = project.title || baseName(folder)

  return (
    <div className="flex h-full min-h-0 flex-col" onPointerDownCapture={beginBatch} onPointerUpCapture={endBatch} onPointerCancelCapture={endBatch}>
      <TopBar
        name={name}
        onBack={onBack}
        onRename={(title) => onProject((p) => ({ ...p, title }))}
        status={saveStatus}
        right={
          <>
            <div className="flex items-center gap-0.5 border-r border-line pr-2">
              <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
                <Undo size={13} />
              </IconButton>
              <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
                <Redo size={13} />
              </IconButton>
            </div>
            <Button size="sm" icon={<Snapshot size={13} />} onClick={() => setThumbnailOpen(true)} disabled={!hasDuration} title="Create a thumbnail">
              Thumbnail
            </Button>
            <Button size="sm" icon={<Region size={13} />} onClick={() => setCropOpen(true)} title="Crop source">
              Crop
            </Button>
            <Button variant="primary" size="sm" icon={<Export size={13} />} onClick={() => setExportOpen(true)} disabled={!hasDuration} title="Export (Ctrl+E)">
              Export
              <span className="ml-1 flex items-center gap-0.5 opacity-70">
                <Kbd>Ctrl</Kbd>
                <Kbd>E</Kbd>
              </span>
            </Button>
          </>
        }
      />

      <div className="editor-workspace focus-canvas flex min-h-0 flex-1 overflow-hidden">
        {/* Stage */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="editor-stage-shell relative min-h-0 flex-1 bg-bg-0">
            <div className="absolute inset-6">
              <Preview
                urls={media}
                events={events}
                project={project}
                segments={segments}
                pointerPath={pointerPath}
                backgroundImage={backgroundImage}
                overlayImages={overlayImages}
                selectedOverlayId={selectedOverlayId}
                duration={duration}
                time={time}
                playing={playing}
                trim={trim}
                onTime={setTime}
                onPlayingChange={setPlaying}
                onDuration={setDuration}
                onError={setPreviewError}
                onSelectOverlay={selectOverlay}
                onOverlayPatch={patchOverlay}
                onFramePatch={patchFrame}
              />
            </div>
            {!hasDuration && !previewError && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-fg-dim">
                <Spinner size={18} />
              </div>
            )}
            {previewError && (
              <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-[8px] border border-danger/30 bg-bg-2 px-3 py-1.5 text-[12px] text-danger shadow-[var(--shadow-pop)]">
                <Warning size={14} /> {previewError}
              </div>
            )}
            {/* A take with no clicks has no ripples, no click sound and no auto zoom. Saying so
                here is the difference between a known limitation and an editor that looks broken. */}
            {!previewError && events.inputNote && events.clicks.length === 0 && (
              <div className="absolute left-1/2 top-4 flex max-w-[70%] -translate-x-1/2 items-center gap-2 rounded-[8px] border border-accent/30 bg-bg-2 px-3 py-1.5 text-[12px] text-accent shadow-[var(--shadow-pop)]">
                <Warning size={14} /> {events.inputNote}
              </div>
            )}
          </div>
          <div className="editor-timeline shrink-0 border-t border-line bg-bg-1 px-3 pb-3">
            <Transport time={time} duration={duration} trim={trim} playing={playing} onToggle={togglePlay} onSeek={seek} onSetIn={setIn} onSetOut={setOut} disabled={!hasDuration} keptSeconds={keptSeconds} canSplit={canSplit} onSplit={splitAtPlayhead} selectedClip={selectedClip} onRemoveClip={removeSelectedClip} onRestoreClip={restoreSelectedClip} clipSpeed={selectedClip ? clipSpeed(project.speedRegions, selectedClip) : null} onClipSpeed={setSelectedClipSpeed} />
            <ScrubBar
              duration={duration}
              time={time}
              trim={trim}
              segments={segments}
              selectedId={selectedZoomId}
              overlays={project.overlays}
              selectedOverlayId={selectedOverlayId}
              onSeek={seek}
              onTrim={setTrim}
              onSelect={selectZoom}
              onAddSegment={addSegmentAt}
              onResizeSegment={patchSegment}
              pauses={events.pauses}
              onSelectOverlay={selectOverlay}
              onResizeOverlay={patchOverlay}
              clips={clips}
              selectedClipId={selectedClipId}
              onSelectClip={selectClip}
            />
            <RegionLanes project={project} duration={duration} onProject={onProject} beginBatch={beginBatch} endBatch={endBatch} />
          </div>
        </div>

        {/* Knobs */}
        <aside className="editor-inspector min-h-0 shrink-0 overflow-hidden border-l border-line bg-bg-1">
          <Knobs
            selectedOverlayId={selectedOverlayId}
            project={project}
            onProject={onProject}
            files={files}
            audioUrls={{ mic: media.mic, system: media.system }}
            clickTimes={clickTimes}
            stepMarks={stepMarks}
            hasCleanMic={!!cleanMicUrl}
            onCleanMic={async () => setCleanMicUrl(await window.polish.cleanMic(files.folder))}
            outSize={outSize}
            region={events.region}
            duration={duration}
            segments={segments}
            selected={selected}
            onSegmentPatch={(s, p) => void patchSegment(s, p)}
            onSegmentDelete={deleteSegment}
            onSelect={selectZoom}
            onRestoreAuto={() => onProject(restoreAutoSegments)}
          >
            <Overlays
              overlays={project.overlays}
              selectedId={selectedOverlayId}
              duration={duration}
              time={time}
              onSelect={selectOverlay}
              onAdd={addOverlayAtPlayhead}
              onPatch={patchOverlay}
              onDelete={deleteOverlay}
              onDuplicate={copyOverlay}
              onSeek={seek}
            />
          </Knobs>
        </aside>
      </div>

      <ExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        loaded={mediaLoaded}
        project={project}
        onProject={onProject}
        duration={duration}
        trim={trim}
        backgroundImage={backgroundImage}
        overlayImages={overlayImages}
        defaultName={name}
      />
      <ThumbnailSheet
        open={thumbnailOpen}
        onClose={() => setThumbnailOpen(false)}
        loaded={mediaLoaded}
        project={project}
        duration={duration}
        time={time}
        segments={segments}
        pointerPath={pointerPath}
        backgroundImage={backgroundImage}
        overlayImages={overlayImages}
        defaultName={name}
      />
      {cropOpen && (
        <CropEditor
          sourceUrl={urls.screen}
          sourceAspect={events.region.width / events.region.height}
          initial={project.crop}
          onApply={(crop) => {
            onProject((p) => ({ ...p, crop }))
            setCropOpen(false)
          }}
          onCancel={() => setCropOpen(false)}
        />
      )}
    </div>
  )
}
