import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { syncEvents } from '../../shared/input-sync'
import type { ImageFormat, LoadedProject } from '../../shared/ipc'
import type { Project, ZoomSegment } from '../../shared/types'
import { outputSize } from '../../shared/layout'
import { renderFrame, type FrameInput } from '../../render/render-frame'
import { clamp, formatTime } from '../lib/time'
import { Check, Folder, ImageIcon, Snapshot, Spinner, Warning } from './icons'
import { Button, Modal, Row, Segmented, Select, SliderField, TextInput, Toggle, cx } from './ui'

type SizeChoice = 'video' | '1280x720' | '1920x1080' | '1080x1920'
type Phase = { kind: 'idle' } | { kind: 'running'; what: 'save' | 'cover' } | { kind: 'done'; path: string; what: 'save' | 'cover' } | { kind: 'error'; message: string }

export interface ThumbnailSheetProps {
  open: boolean
  onClose: () => void
  loaded: LoadedProject
  project: Project
  duration: number
  /** Playhead when the sheet opened; the frame picker starts there. */
  time: number
  segments: ZoomSegment[]
  pointerPath: Array<[number, number, number]>
  backgroundImage: CanvasImageSource | null
  overlayImages: Map<string, CanvasImageSource>
  defaultName: string
}

const SIZE_OPTIONS: Array<{ value: SizeChoice; label: string }> = [
  { value: 'video', label: 'Video size' },
  { value: '1280x720', label: '1280 x 720' },
  { value: '1920x1080', label: '1920 x 1080' },
  { value: '1080x1920', label: '1080 x 1920' }
]

function sizeFor(choice: SizeChoice, project: Project, videoSize: { width: number; height: number }): { width: number; height: number } {
  if (choice === 'video') return outputSize(project, videoSize)
  const [w, h] = choice.split('x').map(Number)
  return { width: w, height: h }
}

/**
 * Thumbnail maker: pick a frame, render it with the same renderFrame as the
 * video (optionally ignoring overlay timing), save it as PNG/JPG under
 * exports/, or make it the library cover (exports/thumb.jpg).
 */
export function ThumbnailSheet(props: ThumbnailSheetProps) {
  const { open, onClose, loaded, project, duration, time, segments, pointerPath, backgroundImage, overlayImages, defaultName } = props
  const hasDuration = Number.isFinite(duration) && duration > 0
  const [t, setT] = useState(time)
  const [includeTimed, setIncludeTimed] = useState(true)
  const [sizeChoice, setSizeChoice] = useState<SizeChoice>('video')
  const [format, setFormat] = useState<ImageFormat>('png')
  const [quality, setQuality] = useState(0.9)
  const [name, setName] = useState(`${defaultName} thumbnail`)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [ready, setReady] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const webcamRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const videoSize = useMemo(() => ({ width: loaded.events.region.width, height: loaded.events.region.height }), [loaded.events.region])
  const size = useMemo(() => sizeFor(sizeChoice, project, videoSize), [sizeChoice, project, videoSize])

  useEffect(() => {
    if (open) {
      setT(clamp(time, 0, hasDuration ? duration : time))
      setPhase({ kind: 'idle' })
      setName(`${defaultName} thumbnail`)
      setReady(false)
    }
  }, [open, time, duration, hasDuration, defaultName])

  const latest = useRef({ project, segments, pointerPath, backgroundImage, overlayImages, includeTimed, videoSize, duration, t })
  latest.current = { project, segments, pointerPath, backgroundImage, overlayImages, includeTimed, videoSize, duration, t }

  const frameInput = useCallback((video: CanvasImageSource, tSec: number): FrameInput => {
    const l = latest.current
    const webcam = webcamRef.current
    return {
      video,
      videoSize: l.videoSize,
      tSec,
      events: syncEvents(loaded.events, l.project.cursor.syncSec),
      project: l.project,
      segments: l.segments,
      pointerPath: l.pointerPath,
      webcam: l.project.webcam.enabled && webcam && webcam.readyState >= 2 ? webcam : null,
      backgroundImage: l.backgroundImage,
      overlayImages: l.overlayImages,
      overlaysIgnoreTime: !l.includeTimed,
      duration: Number.isFinite(l.duration) && l.duration > 0 ? l.duration : undefined
    }
  }, [loaded.events])

  const render = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || video.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    renderFrame(ctx, frameInput(video, video.currentTime))
  }, [frameInput])

  // Media elements: load once per open, seek on t, render on seeked.
  useEffect(() => {
    if (!open) return
    const video = videoRef.current
    const webcam = webcamRef.current
    if (!video) return
    video.crossOrigin = 'anonymous'
    video.src = loaded.urls.screen
    video.load()
    if (webcam) {
      if (loaded.urls.webcam) {
        webcam.crossOrigin = 'anonymous'
        webcam.src = loaded.urls.webcam
        webcam.load()
      } else webcam.removeAttribute('src')
    }
    const onSeeked = () => {
      setReady(true)
      render()
    }
    const onLoaded = () => {
      video.currentTime = latest.current.t
      if (webcam && webcam.getAttribute('src')) webcam.currentTime = latest.current.t
    }
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('seeked', onSeeked)
    webcam?.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('seeked', onSeeked)
      webcam?.removeEventListener('seeked', onSeeked)
      video.removeAttribute('src')
      video.load()
      webcam?.removeAttribute('src')
    }
  }, [open, loaded.urls.screen, loaded.urls.webcam, render])

  // Frame picker seeks the hidden video.
  useEffect(() => {
    if (!open) return
    const video = videoRef.current
    const webcam = webcamRef.current
    if (!video || video.readyState < 1) return
    setReady(false)
    video.currentTime = t
    if (webcam && webcam.getAttribute('src')) webcam.currentTime = t
  }, [open, t])

  // Canvas size follows the size choice; options redraw the current frame.
  useEffect(() => {
    if (!open) return
    const canvas = canvasRef.current
    if (canvas && (canvas.width !== size.width || canvas.height !== size.height)) {
      canvas.width = size.width
      canvas.height = size.height
    }
    render()
  }, [open, size.width, size.height, includeTimed, project, segments, pointerPath, backgroundImage, overlayImages, render])

  const encode = async (fmt: ImageFormat, target: { width: number; height: number }, q: number): Promise<ArrayBuffer> => {
    const video = videoRef.current
    if (!video || video.readyState < 2) throw new Error('The frame is not decoded yet')
    const off = new OffscreenCanvas(target.width, target.height)
    const ctx = off.getContext('2d')
    if (!ctx) throw new Error('Could not create a 2D context')
    renderFrame(ctx, frameInput(video, video.currentTime))
    const blob = await off.convertToBlob(fmt === 'jpg' ? { type: 'image/jpeg', quality: q } : { type: 'image/png' })
    return blob.arrayBuffer()
  }

  const cleanName = name.trim().replace(/[<>:"/\\|?*]/g, '-')

  const save = async () => {
    setPhase({ kind: 'running', what: 'save' })
    try {
      const data = await encode(format, size, quality)
      const { path } = await window.polish.saveImage({ folder: loaded.files.folder, name: cleanName || defaultName, format, data })
      setPhase({ kind: 'done', path, what: 'save' })
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const setCover = async () => {
    setPhase({ kind: 'running', what: 'cover' })
    try {
      // The library card is small; 1280 wide keeps thumb.jpg light regardless of the chosen size.
      const w = 1280
      const h = Math.max(2, Math.round((size.height / size.width) * w / 2) * 2)
      const data = await encode('jpg', { width: w, height: h }, 0.86)
      const { path } = await window.polish.setCover({ folder: loaded.files.folder, data })
      setPhase({ kind: 'done', path, what: 'cover' })
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const running = phase.kind === 'running'
  const canExport = ready && !running

  return (
    <Modal open={open} onClose={onClose} title="Thumbnail" closable={!running} width={640}>
      <div className="flex flex-col gap-3">
        <div className="relative overflow-hidden rounded-[8px] border border-line bg-bg-0">
          <canvas
            ref={canvasRef}
            width={size.width}
            height={size.height}
            className="block w-full"
            style={{ aspectRatio: `${size.width} / ${size.height}`, maxHeight: 360, margin: '0 auto', height: 'auto', objectFit: 'contain' }}
            aria-label="Thumbnail preview"
          />
          {!ready && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-fg-dim">
              <Spinner size={16} />
            </div>
          )}
          <video ref={videoRef} muted playsInline preload="auto" className="hidden" />
          <video ref={webcamRef} muted playsInline preload="auto" className="hidden" />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-fg">Frame</span>
            <span className="font-mono text-[11px] tabular-nums text-fg-muted">{formatTime(t)}</span>
          </div>
          <input
            type="range"
            className="slider"
            min={0}
            max={hasDuration ? duration : 1}
            step={0.01}
            value={t}
            disabled={!hasDuration || running}
            style={{ ['--fill' as string]: `${hasDuration ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0}%` }}
            onChange={(e) => setT(Number(e.target.value))}
            aria-label="Frame time"
          />
        </div>

        <Row label="Include timed overlays" hint="Off shows every overlay regardless of its time range">
          <Toggle checked={includeTimed} onChange={setIncludeTimed} disabled={running} label="Include timed overlays" />
        </Row>
        <Row label="Size">
          <Select<SizeChoice> ariaLabel="Thumbnail size" value={sizeChoice} onChange={setSizeChoice} options={SIZE_OPTIONS} disabled={running} />
        </Row>
        <Row label="Format">
          <Segmented<ImageFormat>
            full={false}
            size="sm"
            disabled={running}
            value={format}
            onChange={setFormat}
            options={[
              { value: 'png', label: 'PNG', title: 'Lossless' },
              { value: 'jpg', label: 'JPG', title: 'Smaller' }
            ]}
          />
        </Row>
        {format === 'jpg' && <SliderField label="Quality" value={quality} min={0.5} max={1} step={0.01} disabled={running} onChange={setQuality} format={(v) => `${Math.round(v * 100)}%`} />}
        <Row label="File name">
          <div className="flex items-center gap-1.5">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={running} className="w-[220px]" spellCheck={false} aria-label="File name" />
            <span className="text-[12px] text-fg-dim">.{format}</span>
          </div>
        </Row>

        {phase.kind === 'error' && (
          <div className="fade-in flex items-start gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
            <Warning size={14} className="mt-[1px] shrink-0" />
            <span style={{ userSelect: 'text' }}>{phase.message}</span>
          </div>
        )}
        {phase.kind === 'done' && (
          <div className="fade-in flex items-center gap-2 rounded-[8px] border border-ok/30 bg-ok/10 px-3 py-2 text-[12px] text-fg">
            <Check size={14} className="shrink-0 text-ok" />
            <span className="min-w-0 flex-1 truncate" title={phase.path} style={{ userSelect: 'text' }}>
              {phase.what === 'cover' ? 'Library cover updated' : phase.path}
            </span>
            <Button size="sm" variant="ghost" icon={<Folder size={13} />} onClick={() => void window.polish.reveal(phase.path)}>
              Reveal
            </Button>
          </div>
        )}

        <div className={cx('flex items-center justify-end gap-2 pt-1')}>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {phase.kind === 'done' ? 'Done' : 'Close'}
          </Button>
          <Button variant="default" icon={running && phase.what === 'cover' ? <Spinner size={13} /> : <ImageIcon size={13} />} onClick={() => void setCover()} disabled={!canExport} title="Write exports/thumb.jpg, shown in the library">
            Set as library cover
          </Button>
          <Button variant="primary" icon={running && phase.what === 'save' ? <Spinner size={13} /> : <Snapshot size={14} />} onClick={() => void save()} disabled={!canExport}>
            Save {format.toUpperCase()}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
