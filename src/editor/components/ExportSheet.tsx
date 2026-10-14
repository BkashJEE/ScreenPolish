import { useEffect, useRef, useState } from 'react'
import { syncEvents } from '../../shared/input-sync'
import { exportDurationSec, sceneTimeline } from '../../shared/scenes'
import type { ExportKind, LoadedProject } from '../../shared/ipc'
import type { ExportQuality, GifOptions, OutputAspect, OutputHeight, Project } from '../../shared/types'
import { outputSize } from '../../shared/layout'
import { speedSpans } from '../../shared/speed'
import { estimateBytes, formatBytes, gifFps, gifWidth, pickBitrate } from '../lib/bitrate'
import { ExportCancelled, exportProject } from '../lib/export'
import { patchGroup } from '../lib/project'
import { formatTime } from '../lib/time'
import { Check, Copy, Export, Folder, Play, Spinner, Warning } from './icons'
import { Button, Modal, Row, Segmented, Select, TextInput, Toggle, cx } from './ui'

type Phase = { kind: 'idle' } | { kind: 'running'; fraction: number } | { kind: 'done'; path: string } | { kind: 'error'; message: string }

export interface ExportSheetProps {
  open: boolean
  onClose: () => void
  loaded: LoadedProject
  project: Project
  onProject: (update: (p: Project) => Project) => void
  duration: number
  trim: { start: number; end: number }
  backgroundImage: CanvasImageSource | null
  overlayImages: Map<string, CanvasImageSource>
  defaultName: string
}

export function ExportSheet(props: ExportSheetProps) {
  const { open, onClose, loaded, project, onProject, duration, trim, backgroundImage, overlayImages, defaultName } = props
  const [kind, setKind] = useState<ExportKind>('mp4')
  const [name, setName] = useState(defaultName)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)

  async function copyFile(): Promise<void> {
    if (phase.kind !== 'done') return
    await window.polish.copyFile(phase.path)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  useEffect(() => {
    if (open) {
      setPhase({ kind: 'idle' })
      setCopied(false)
      setName(defaultName)
    }
  }, [open, defaultName])

  const videoSize = { width: loaded.events.region.width, height: loaded.events.region.height }
  const size = outputSize(project, videoSize)
  // Exported length: removed clips drop out and speed regions stretch or squeeze.
  const recordingSeconds = Math.max(0, speedSpans(trim.start, trim.end, project.speedRegions, project.cuts).at(-1)?.outputEnd ?? 0)
  // Plus any intro and outro cards.
  const seconds = exportDurationSec(sceneTimeline(project.scenes ?? [], recordingSeconds), recordingSeconds)
  const running = phase.kind === 'running'
  const cleanName = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
  const quality = project.output.quality ?? 'balanced'
  const gif = project.output.gif ?? {}
  const gfps = gifFps(quality, gif.fps)
  const gw = gifWidth(size.width, quality, gif.width)
  const setGif = (patch: Partial<GifOptions>) => onProject((p) => patchGroup(p, 'output', { gif: { ...(p.output.gif ?? {}), ...patch } }))

  const start = async () => {
    const controller = new AbortController()
    abort.current = controller
    setPhase({ kind: 'running', fraction: 0 })
    try {
      const { path } = await exportProject({
        folder: loaded.files.folder,
        urls: loaded.urls,
        events: syncEvents(loaded.events, project.cursor.syncSec),
        project,
        kind,
        name: cleanName || defaultName,
        backgroundImage,
        overlayImages,
        signal: controller.signal,
        onProgress: (fraction) => setPhase((p) => (p.kind === 'running' ? { kind: 'running', fraction } : p))
      })
      setPhase({ kind: 'done', path })
    } catch (e) {
      if (e instanceof ExportCancelled || controller.signal.aborted) setPhase({ kind: 'idle' })
      else setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      abort.current = null
    }
  }

  const cancel = () => abort.current?.abort()

  return (
    <Modal open={open} onClose={onClose} title="Export" closable={!running} width={460}>
      <div className="flex flex-col gap-3">
        <Segmented<ExportKind>
          value={kind}
          onChange={setKind}
          disabled={running}
          options={[
            { value: 'mp4', label: 'MP4', title: 'H264 + AAC' },
            { value: 'gif', label: 'GIF', title: `${gfps} fps, up to ${gw} px wide` }
          ]}
        />
        <Row label="Aspect">
          <Segmented<OutputAspect>
            full={false}
            size="sm"
            disabled={running}
            value={project.output.aspect}
            onChange={(aspect) => onProject((p) => patchGroup(p, 'output', { aspect }))}
            options={[
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16' },
              { value: '1:1', label: '1:1' },
              { value: '4:5', label: '4:5' },
              { value: '4:3', label: '4:3' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </Row>
        <Row label="Height">
          <Select<OutputHeight>
            ariaLabel="Export height"
            disabled={running}
            value={project.output.height}
            onChange={(height) => onProject((p) => patchGroup(p, 'output', { height }))}
            options={[
              { value: 720, label: '720p' },
              { value: 1080, label: '1080p' },
              { value: 1440, label: '1440p' },
              { value: 2160, label: '2160p' }
            ]}
          />
        </Row>
        {kind === 'mp4' && <Row label="Frame rate">
          <Segmented<30 | 60> value={project.output.fps} disabled={running} onChange={(fps) => onProject((p) => patchGroup(p, 'output', { fps }))} options={[{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }]} />
        </Row>}
        <Row label="Quality" hint={kind === 'gif' ? `${gfps} fps, ${gw} px wide` : `${(pickBitrate(size.height, quality, project.output.fps, size.width) / 1_000_000).toFixed(1)} Mbps`}>
          <Segmented<ExportQuality>
            full={false}
            size="sm"
            disabled={running}
            value={quality}
            onChange={(q) => onProject((p) => patchGroup(p, 'output', { quality: q }))}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'high', label: 'High' }
            ]}
          />
        </Row>
        {kind === 'gif' && (
          <>
            <Row label="GIF frame rate" hint="Fewer frames, smaller file">
              <Segmented<10 | 15 | 20 | 25>
                full={false}
                size="sm"
                disabled={running}
                value={(gif.fps ?? 0) as 10 | 15 | 20 | 25}
                onChange={(fps) => setGif({ fps })}
                options={[10, 15, 20, 25].map((v) => ({ value: v as 10 | 15 | 20 | 25, label: String(v) }))}
              />
            </Row>
            <Row label="GIF width" hint={gif.width ? undefined : `Following Quality: ${gw} px`}>
              <Segmented<480 | 640 | 960 | 1280>
                full={false}
                size="sm"
                disabled={running}
                value={(gif.width ?? 0) as 480 | 640 | 960 | 1280}
                onChange={(width) => setGif({ width })}
                options={[480, 640, 960, 1280].filter((v) => v === 480 || v <= size.width).map((v) => ({ value: v as 480 | 640 | 960 | 1280, label: String(v) }))}
              />
            </Row>
            <Row label="Loop" hint={gif.loop === false ? 'Plays once and stops on the last frame' : 'Plays over and over'}>
              <Toggle checked={gif.loop !== false} disabled={running} label="Loop" onChange={(loop) => setGif({ loop })} />
            </Row>
          </>
        )}
        <Row label="File name">
          <div className="flex items-center gap-1.5">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={running} className="w-[200px]" spellCheck={false} aria-label="File name" />
            <span className="text-[12px] text-fg-dim">.{kind}</span>
          </div>
        </Row>

        <div className="grid grid-cols-3 gap-2 rounded-[8px] bg-bg-1 p-2.5 text-[11.5px]">
          <Stat label="Size" value={kind === 'gif' ? `${gw} x ${Math.round((size.height * gw) / size.width)}` : `${size.width} x ${size.height}`} />
          <Stat label="Length" value={formatTime(seconds, { fraction: false })} />
          <Stat label="Estimate" value={`~${formatBytes(estimateBytes({ kind, width: size.width, height: size.height, seconds, quality, fps: project.output.fps, gif }))}`} />
        </div>

        {phase.kind === 'running' && (
          <div className="fade-in flex flex-col gap-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-4">
              <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.round(phase.fraction * 100)}%` }} />
            </div>
            <div className="flex items-center justify-between text-[11.5px] text-fg-muted">
              <span className="flex items-center gap-1.5">
                <Spinner size={12} /> {phase.fraction >= 0.99 ? (kind === 'gif' ? 'Converting to GIF' : 'Finishing') : 'Rendering'}
              </span>
              <span className="font-mono tabular-nums">{Math.round(phase.fraction * 100)}%</span>
            </div>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="fade-in flex items-start gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
            <Warning size={14} className="mt-[1px] shrink-0" />
            <span style={{ userSelect: 'text' }}>{phase.message}</span>
          </div>
        )}
        {phase.kind === 'done' && (
          <div className="fade-in flex flex-col gap-2 rounded-[8px] border border-ok/30 bg-ok/10 px-3 py-2 text-[12px] text-fg">
            <div className="flex items-center gap-2">
              <Check size={14} className="shrink-0 text-ok" />
              {/* Dragging the name carries the file out, into a chat window or
                  an upload box. Linux offers nothing more native than this. */}
              <span
                className="min-w-0 flex-1 cursor-grab truncate active:cursor-grabbing"
                title={`${phase.path}\n\nDrag this into another window to send the file`}
                draggable
                onDragStart={(e) => {
                  e.preventDefault()
                  window.polish.dragFile(phase.path)
                }}
                style={{ userSelect: 'text' }}
              >
                {phase.path}
              </span>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void copyFile()} title="Copy the file, to paste into a chat or an upload box">
                {copied ? 'Copied' : 'Copy file'}
              </Button>
              <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={() => void window.polish.openFile(phase.path)} title="Open in the default player">
                Open
              </Button>
              <Button size="sm" variant="ghost" icon={<Folder size={13} />} onClick={() => void window.polish.reveal(phase.path)}>
                Reveal
              </Button>
            </div>
          </div>
        )}

        <div className={cx('flex items-center justify-end gap-2 pt-1')}>
          {running ? (
            <Button variant="danger" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {phase.kind === 'done' ? 'Done' : 'Close'}
              </Button>
              <Button variant="primary" icon={<Export size={14} />} onClick={() => void start()} disabled={!(seconds > 0) || !Number.isFinite(duration)}>
                {phase.kind === 'done' ? 'Export again' : `Export ${kind.toUpperCase()}`}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] uppercase tracking-wide text-fg-dim">{label}</span>
      <span className="font-mono tabular-nums text-fg">{value}</span>
    </div>
  )
}
