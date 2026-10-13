import { useEffect, useMemo, useState } from 'react'
import type { LoadedProject } from '../../shared/ipc'
import type { RecordingSummary } from '../../shared/types'
import { resolveZoomSegments } from '../../shared/zoom-planner'
import { pointerPathFor } from '../../shared/pointer'
import { syncEvents } from '../../shared/input-sync'
import { imageUrlForPath, normalizeProject, normalizeClickSound, normalizeZoomSound } from '../lib/project'
import { loadImage, loadOverlayImages } from '../lib/media'
import { previewSeekTime } from '../lib/hover-preview'
import { resolveTrim } from '../lib/time'
import { Preview } from './Preview'

const noop = () => undefined

/** Read-only Quick Look shares the editor/export renderer, not the raw take. */
export function LibraryPreview({ item, scrub }: { item: RecordingSummary; scrub: number | null }) {
  return <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-10" aria-hidden="true">
    <div className="fade-in w-[min(70vw,980px)] overflow-hidden rounded-2xl bg-bg-1" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <ComposedPreview key={item.folder} item={item} scrub={scrub} />
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{item.title || item.name}</span>
        <span className="text-[11px] text-fg-muted">Saved effects · muted · move to scrub · click to edit</span>
      </div>
    </div>
  </div>
}

function ComposedPreview({ item, scrub }: { item: RecordingSummary; scrub: number | null }) {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [background, setBackground] = useState<HTMLImageElement | null>(null)
  const [images, setImages] = useState<Map<string, CanvasImageSource>>(new Map())
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    let alive = true
    void (async () => {
      const data = await window.polish.load(item.folder)
      const project = normalizeProject(data.project)
      // Silence only this ephemeral view. Never save or modify the take.
      project.audio = { ...project.audio, mic: false, system: false, masterVolume: 0 }
      project.audioRegions = []
      project.cursor = { ...project.cursor, clickSound: { ...normalizeClickSound(project.cursor.clickSound), enabled: false } }
      project.zoom = { ...project.zoom, sound: { ...normalizeZoomSound(project.zoom.sound), enabled: false } }
      const [bg, overlays] = await Promise.all([
        project.background.kind === 'image' && project.background.imagePath
          ? loadImage(imageUrlForPath(project.background.imagePath)) : Promise.resolve(null),
        loadOverlayImages(project.overlays)
      ])
      if (!alive) return
      setBackground(bg)
      setImages(overlays)
      setTime(project.trim.start)
      setLoaded({ ...data, project })
    })().catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [item.folder])

  const trim = useMemo(() => resolveTrim(loaded?.project.trim ?? { start: 0, end: 0 }, duration), [loaded, duration])
  const events = useMemo(() => loaded ? syncEvents(loaded.events, loaded.project.cursor.syncSec) : null, [loaded])
  const segments = useMemo(() => loaded && events && duration > 0 ? resolveZoomSegments(loaded.project, events, duration) : [], [loaded, events, duration])
  const pointer = useMemo(() => loaded && events ? pointerPathFor(events, loaded.project.cursor) : [], [loaded, events])
  useEffect(() => {
    if (scrub === null) return
    const next = previewSeekTime(scrub, trim.end - trim.start)
    if (next !== null) setTime(trim.start + next)
  }, [scrub, trim])

  return <div className="h-[min(60vh,600px)] bg-black">
    {error ? <div className="p-6 text-sm text-fg-muted">Could not preview saved effects. Open the recording to inspect it.</div> : loaded ?
      <Preview hideControls urls={loaded.urls} events={events ?? loaded.events} project={loaded.project}
        segments={segments} pointerPath={pointer} backgroundImage={background} overlayImages={images}
        selectedOverlayId={null} duration={duration} time={time} playing={playing && duration > 0}
        trim={trim} onTime={setTime} onPlayingChange={setPlaying} onDuration={setDuration}
        onError={setError} onSelectOverlay={noop} onOverlayPatch={noop} onFramePatch={noop} /> :
      <div className="p-6 text-sm text-fg-muted">Loading saved effects…</div>}
  </div>
}
