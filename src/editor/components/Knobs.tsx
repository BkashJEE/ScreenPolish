import { memo, useEffect, useState, type ReactNode } from 'react'
import { AGENT_POINTER_COLOR, STAR_POINTER_COLOR, pointerHasOwnClick } from '../../render/render-frame'
import type { FolderBackground, MusicTrack } from '../../shared/ipc'
import { BUNDLED_MUSIC } from '../../shared/bundled-music'
import { CLICK_SOUND_STYLES, DEFAULT_CLICK_SOUND, type ClickSoundStyle } from '../../shared/click-sound'
import { playClick, playZoomSound } from '../lib/click-player'
import { DEFAULT_ZOOM_SOUND, type ZoomSoundStyle } from '../../shared/zoom-sound'
import { MAX_CUT_TRANSITION_SEC, MIN_CUT_TRANSITION_SEC, cutTransitionLabel, normalizeCutTransition, type CutTransitionStyle } from '../../shared/cut-transition'
import { normalizeCuts } from '../../shared/cuts'
import type { LoadedProject } from '../../shared/ipc'
import type { AnimationStyle, CameraStyle, LetteringPosition, MockupKind, MockupTheme, OutputAspect, OutputHeight, Project, WebcamCorner, ZoomSegment } from '../../shared/types'
import { DEFAULT_WEBCAM_LOOK, type WebcamLook } from '../../shared/webcam-look'
import { WEBCAM_INSET, WEBCAM_MAX_MARGIN } from '../../shared/layout'
import { SYNC_MAX_SEC, SYNC_MIN_SEC } from '../../shared/input-sync'
import { ZOOM_TEMPLATES, applyZoomTemplate, matchZoomTemplate } from '../../shared/zoom-templates'
import { baseName } from '../lib/media'
import { PACK_PLATE_INK } from '../../brand'
import { BRAND_CURSORS, BRAND_THEMES } from '../../brand'
import { BannerMark } from '../../brand/ui'
import { GRADIENT_PRESETS, SOLID_PRESETS, backgroundCss, matchPreset, matchSolidPreset, patchGroup, BUNDLED_BACKGROUNDS, BACKGROUND_GROUPS, imageUrlForPath } from '../lib/project'
import { clampFocus, type SegmentPatch } from '../lib/segments'
import { formatTime } from '../lib/time'
import { ImageIcon, Trash, Undo, X } from './icons'
import { SilencePanel } from './SilencePanel'
import { CaptionsPanel } from './CaptionsPanel'
import { LooksPanel } from './LooksPanel'
import { ScenesPanel } from './ScenesPanel'
import { INSPECTOR_TABS, inspectorTabCss, type InspectorTab } from '../lib/inspector-tabs'
import { Button, Chip, ColorField, Kbd, NumberField, Row, Section, Segmented, Select, SliderField, Toggle, cx } from './ui'

export interface KnobsProps {
  selectedOverlayId?: string | null
  project: Project
  onProject: (update: (p: Project) => Project) => void
  files: LoadedProject['files']
  outSize: { width: number; height: number }
  /** Source recording dimensions used to bound camera focus coordinates. */
  region: { width: number; height: number }
  duration: number
  segments: ZoomSegment[]
  selected: ZoomSegment | null
  onSegmentPatch: (segment: ZoomSegment, patch: SegmentPatch) => void
  onSegmentDelete: (segment: ZoomSegment) => void
  onSelect: (id: string | null) => void
  onRestoreAuto: () => void
  /** Extra sections (Overlays) rendered between Webcam and Audio. */
  children?: ReactNode
  /** Recorded audio, for silence removal. */
  audioUrls?: { mic?: string; system?: string }
}

const TAB_CSS = inspectorTabCss()

/** What each bundled theme's lettering is called in its on/off switch. */
/** Seconds of stillness before the pointer starts fading, when the fade is switched on. */
const DEFAULT_IDLE_HIDE_SEC = 2

const THEME_LETTERING: Record<string, string> = {
  ...Object.fromEntries(BRAND_THEMES.map((t) => [t.id, t.letteringLabel])),
  omarchy: 'Omarchy wordmark'
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const signed = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`)

/**
 * Pictures from your own backgrounds folder (Pictures/ScreenPolish), shown
 * next to the ones that ship. Read again whenever the editor regains focus,
 * since the folder is filled from a file manager.
 */
function FolderBackgrounds({ selected, onPick }: { selected: string | undefined; onPick: (path: string) => void }) {
  const [images, setImages] = useState<FolderBackground[] | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.polish
        .listBackgrounds()
        .then(setImages)
        .catch(() => setImages([]))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const openFolder = (): void => {
    void window.polish.openBackgroundsFolder().catch((error) => window.alert(`Could not open the backgrounds folder: ${String(error)}`))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-fg-dim">Your folder</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={openFolder}>
          Open folder
        </Button>
      </div>
      {images && images.length > 0 ? (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Your backgrounds">
          {images.map((b) => (
            <button
              key={b.path}
              type="button"
              aria-label={`Choose ${b.name} background`}
              aria-pressed={selected === b.path}
              title={b.path}
              onClick={() => onPick(b.path)}
              className={cx(
                'overflow-hidden rounded-[6px] border text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg',
                selected === b.path ? 'border-fg ring-1 ring-fg' : 'border-line-strong'
              )}
            >
              <span className="block aspect-video" style={{ backgroundImage: `url(${imageUrlForPath(b.path)})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              <span className="block truncate px-2 py-1.5 text-[11px] text-fg-dim">{b.name}</span>
            </button>
          ))}
        </div>
      ) : (
        images && <p className="text-[11.5px] leading-[1.45] text-fg-dim">Put pictures in Pictures/ScreenPolish and they appear here.</p>
      )}
    </div>
  )
}

/**
 * The music shelf: whatever is in the music folder, one click from the take.
 *
 * Picking a file from a dialog every time means keeping a folder of tracks in
 * your head. This lists the folder instead, and stays a folder — drop a file
 * in, it is there; delete it, it is gone. The dialog is kept for anything
 * living elsewhere.
 */
function MusicShelf({ disabled, onAdd }: { disabled: boolean; onAdd: (path: string) => void }) {
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [open, setOpen] = useState(false)

  const refresh = (): void => {
    void window.polish
      .listMusic()
      .then(setTracks)
      .catch(() => setTracks([]))
  }
  // Read it when the shelf is opened, and again each time, since the folder is
  // edited outside this app.
  useEffect(() => {
    if (open) refresh()
  }, [open])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={disabled} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide music' : 'Music'}
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            void window.polish
              .pickAudio()
              .then((path) => {
                if (path) onAdd(path)
              })
              .catch((error) => window.alert(`Could not select audio: ${String(error)}`))
          }}
        >
          Choose a file
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-1 rounded border border-line p-2">
          {/* What ships with the app, written for it and free of any licence. */}
          {BUNDLED_MUSIC.map((track) => (
            <button
              key={track.path}
              type="button"
              disabled={disabled}
              title={`${track.note} — included with ScreenPolish`}
              className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-bg-4 disabled:opacity-50"
              onClick={() => onAdd(track.path)}
            >
              <span className="min-w-0 truncate">{track.name}</span>
              <span className="shrink-0 text-fg-dim">{track.note}</span>
            </button>
          ))}
          <div className="mt-1 border-t border-line pt-1 text-[10px] uppercase tracking-wide text-fg-dim">Your music folder</div>
          {tracks.length === 0 ? (
            <span className="text-[11px] text-fg-dim">
              Empty. Put audio files in the music folder and they appear here.
            </span>
          ) : (
            tracks.map((track) => (
              <button
                key={track.path}
                type="button"
                disabled={disabled}
                title={track.path}
                className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-bg-4 disabled:opacity-50"
                onClick={() => onAdd(track.path)}
              >
                <span className="min-w-0 truncate">{track.name}</span>
                <span className="shrink-0 text-fg-dim">{Math.max(1, Math.round(track.bytes / 1_000_000))} MB</span>
              </button>
            ))
          )}
          <div className="flex items-center gap-1.5 pt-1">
            <Button size="sm" variant="ghost" onClick={() => void window.polish.openMusicFolder().then(refresh)}>
              Open folder
            </Button>
            <Button size="sm" variant="ghost" onClick={refresh}>
              Refresh
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const Knobs = memo(function Knobs(props: KnobsProps) {
  const [playful, setPlayful] = useState(() => localStorage.getItem('screenpolish.playful-sliders') === 'true')
  const [panel, setPanel] = useState<InspectorTab>('scene')
  useEffect(() => { if (props.selected) setPanel('motion') }, [props.selected?.id])
  useEffect(() => { if (props.selectedOverlayId) setPanel('layers') }, [props.selectedOverlayId])
  const { project, onProject, files, outSize, region, duration: rawDuration, segments, selected, onSegmentPatch, onSegmentDelete, onSelect, onRestoreAuto, children } = props
  const duration = Number.isFinite(rawDuration) ? rawDuration : 0
  const set = <K extends keyof Project>(key: K, patch: Partial<Project[K]>) => onProject((p) => patchGroup(p, key, patch))
  const clickSound = project.cursor.clickSound ?? DEFAULT_CLICK_SOUND
  const zoomSound = project.zoom.sound ?? DEFAULT_ZOOM_SOUND
  const cutTransition = normalizeCutTransition(project.cutTransition)
  const removedClips = normalizeCuts(project.cuts).length

  // `look` is absent on projects saved before it existed, so read through a default
  // and always write the whole object back rather than a partial.
  const look = { ...DEFAULT_WEBCAM_LOOK, ...(project.webcam.look ?? {}) }
  const setLook = (patch: Partial<WebcamLook>) => set('webcam', { look: { ...look, ...patch } })
  // The hand placement, or where the chosen corner puts it, so the sliders start where the bubble is.
  const webcamPlace = project.webcam.place ?? { x: project.webcam.corner === 'tl' || project.webcam.corner === 'bl' ? 0 : 1, y: project.webcam.corner === 'tl' || project.webcam.corner === 'tr' ? 0 : 1 }

  const bg = project.background
  // A bundled theme background carries its name as lettering; say which, so it can be switched on or off.
  const theme = bg.kind === 'image' ? BUNDLED_BACKGROUNDS.find((b) => b.path === bg.imagePath) : undefined
  // Only themes that carry a wordmark get the lettering toggle. The drawn
  // backgrounds are nobody's branding and have no name to write.
  const themeLettering = theme && THEME_LETTERING[theme.id] ? { label: THEME_LETTERING[theme.id] } : null
  const preset = matchPreset(bg)
  const solidPreset = matchSolidPreset(bg)
  const autoCount = segments.filter((s) => s.source === 'auto').length
  const manualCount = segments.length - autoCount

  return (
    <div className="studio-inspector-groups flex h-full flex-col overflow-y-auto" data-panel={panel} data-playful-sliders={playful}>
      <style>{TAB_CSS}</style>
      <nav className="inspector-group-nav" aria-label="Inspector categories">
        {INSPECTOR_TABS.map((tab) => <button key={tab.id} type="button" aria-pressed={panel === tab.id} onClick={() => setPanel(tab.id)}>{tab.label}</button>)}
      </nav>
      <Section title="Looks" defaultOpen={false}>
        <LooksPanel project={project} onProject={onProject} />
      </Section>
      <Section title="Editor feel" defaultOpen={false}>
        <Row label="Playful sliders" hint="Elastic drag and spring-back; editor only">
          <Toggle checked={playful} label="Playful sliders" onChange={(enabled) => { setPlayful(enabled); localStorage.setItem('screenpolish.playful-sliders', String(enabled)) }} />
        </Row>
      </Section>
      {/* Layout ------------------------------------------------------------- */}
      <Section title="Layout" right={<span className="font-mono text-[10.5px] tabular-nums text-fg-dim">{outSize.width} x {outSize.height}</span>}>
        <Segmented<OutputAspect>
          value={project.output.aspect}
          onChange={(aspect) => set('output', { aspect })}
          options={[
            { value: '16:9', label: '16:9', title: 'Landscape' },
            { value: '9:16', label: '9:16', title: 'Vertical' },
            { value: '1:1', label: '1:1', title: 'Square' },
            { value: '4:5', label: '4:5', title: 'Feed post (Instagram, LinkedIn)' },
            { value: '4:3', label: '4:3', title: 'Slides' },
            { value: 'source', label: 'Source', title: 'Match the recording' }
          ]}
        />
        <Row label="Height">
          <Select<OutputHeight>
            ariaLabel="Output height"
            value={project.output.height}
            onChange={(height) => set('output', { height })}
            options={[
              { value: 720, label: '720p' },
              { value: 1080, label: '1080p' },
              { value: 1440, label: '1440p' },
              { value: 2160, label: '2160p' }
            ]}
          />
        </Row>
        <Row label="Frame rate">
          <Segmented<30 | 60>
            full={false}
            size="sm"
            value={project.output.fps}
            onChange={(fps) => set('output', { fps })}
            options={[
              { value: 30, label: '30' },
              { value: 60, label: '60' }
            ]}
          />
        </Row>
      </Section>

      {/* Background --------------------------------------------------------- */}
      <Section title="Title cards" right={(project.scenes ?? []).length ? <Chip tone="ok">{(project.scenes ?? []).length}</Chip> : undefined}>
        <ScenesPanel project={project} onProject={onProject} />
      </Section>

      <Section title="Speed regions">
        <p className="text-[11px] text-fg-muted">Times refer to the original recording. Drag regions on their timeline lanes to move or resize.</p>
        <Row label="Preserve audio pitch"><Toggle label="Preserve audio pitch" checked={project.preserveAudioPitch !== false} onChange={preserveAudioPitch => onProject(project=>({...project,preserveAudioPitch}))} /></Row>
        {(project.speedRegions ?? []).map((r) => <div key={r.id} className="flex flex-col gap-2 rounded border border-line p-2">
          <NumberField ariaLabel="Speed start" value={r.start} min={0} max={r.end - 0.1} step={0.1} suffix="s" onChange={(start) => onProject((p) => ({ ...p, speedRegions: (p.speedRegions ?? []).map((v) => v.id === r.id ? { ...v, start } : v) }))} />
          <NumberField ariaLabel="Speed end" value={r.end} min={r.start + 0.1} max={duration} step={0.1} suffix="s" onChange={(end) => onProject((p) => ({ ...p, speedRegions: (p.speedRegions ?? []).map((v) => v.id === r.id ? { ...v, end } : v) }))} />
          <SliderField label="Speed" value={r.rate} min={0.25} max={4} step={0.25} format={(v) => `${v}×`} onChange={(rate) => onProject((p) => ({ ...p, speedRegions: (p.speedRegions ?? []).map((v) => v.id === r.id ? { ...v, rate } : v) }))} />
          <SliderField
            label="Ramp"
            value={r.ease ?? 0}
            min={0}
            max={Math.max(0.1, (r.end - r.start) / 2)}
            step={0.05}
            format={(v) => (v <= 0 ? 'Instant' : `${v.toFixed(2)} s`)}
            onChange={(ease) => onProject((p) => ({ ...p, speedRegions: (p.speedRegions ?? []).map((v) => v.id === r.id ? { ...v, ease } : v) }))}
          />
          <p className="text-[11px] text-fg-muted">
            {(r.ease ?? 0) <= 0
              ? 'The speed changes in one frame. A ramp eases into it and back out, which is what stops a cut announcing itself.'
              : `Eases from 1× up to ${r.rate}× over ${(r.ease as number).toFixed(2)}s, and back down over the same at the end.`}
          </p>
          <Button size="sm" onClick={() => onProject((p) => ({ ...p, speedRegions: (p.speedRegions ?? []).filter((v) => v.id !== r.id) }))}>Remove</Button>
        </div>)}
        <Button size="sm" disabled={duration <= 0} onClick={() => onProject((p) => ({ ...p, speedRegions: [...(p.speedRegions ?? []), { id: crypto.randomUUID(), start: p.trim.start, end: Math.min(duration, p.trim.start + 3), rate: 2 }] }))}>Add speed region</Button>
      </Section>
      <Section title="Cuts" right={removedClips > 0 ? <Chip tone="info">{removedClips} removed</Chip> : undefined}>
        <p className="text-[11px] text-fg-muted">
          Removing a clip leaves a hard cut. A transition covers the join so the edit does not announce itself. Split with <Kbd>S</Kbd>, then Delete.
        </p>
        <Row label="Transition" hint={cutTransition.style === 'none' ? 'The picture changes in one frame.' : cutTransition.style === 'dissolve' ? 'The frame before the cut fades into what follows.' : 'The frame before the cut softens and fades into what follows.'}>
          <Segmented<CutTransitionStyle>
            full={false}
            size="sm"
            value={cutTransition.style}
            onChange={(style) => onProject((p) => ({ ...p, cutTransition: { ...normalizeCutTransition(p.cutTransition), style } }))}
            options={[
              { value: 'none', label: 'None', title: `${cutTransitionLabel('none')}. What was recorded is what plays.` },
              { value: 'dissolve', label: 'Dissolve', title: `${cutTransitionLabel('dissolve')}: hold the frame before the cut and fade it out over what follows.` },
              { value: 'blur', label: 'Blur', title: `${cutTransitionLabel('blur')}: the same fade, softened, which hides a bigger jump.` }
            ]}
          />
        </Row>
        <SliderField
          label="Transition length"
          value={cutTransition.durationSec}
          min={MIN_CUT_TRANSITION_SEC}
          max={MAX_CUT_TRANSITION_SEC}
          step={0.01}
          disabled={cutTransition.style === 'none'}
          format={(v) => `${v.toFixed(2)}s`}
          onChange={(durationSec) => onProject((p) => ({ ...p, cutTransition: { ...normalizeCutTransition(p.cutTransition), durationSec } }))}
        />
        {removedClips === 0 && cutTransition.style !== 'none' && (
          <p className="text-[11px] text-fg-dim">Nothing is removed yet, so there is no join to cover.</p>
        )}
        <div className="mt-1 border-t border-line pt-3">
          <SilencePanel project={project} onProject={onProject} duration={duration} urls={props.audioUrls ?? {}} />
        </div>
      </Section>

      <Section title="Background" right={<span className="h-4 w-4 rounded-[4px] border border-line-strong" style={{ background: backgroundCss(bg) }} />}>
        {/* Sorted into groups: fifteen tiles in one grid was a list to scroll, not a choice. */}
        <div className="flex flex-col gap-3" role="group" aria-label="Background themes">
          {BACKGROUND_GROUPS.map((group) => {
            const items = BUNDLED_BACKGROUNDS.filter((b) => b.group === group.id)
            if (items.length === 0) return null
            return (
              <div key={group.id} className="flex flex-col gap-2">
                <span className="text-[10.5px] uppercase tracking-wide text-fg-dim">{group.label}</span>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label={`${group.label} backgrounds`}>
                  {items.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      aria-label={`Choose ${b.name} background`}
                      aria-pressed={bg.kind === 'image' && bg.imagePath === b.path}
                      onClick={() => set('background', { kind: 'image', imagePath: b.path, lettering: THEME_LETTERING[b.id] !== undefined })}
                      className={cx(
                        'overflow-hidden rounded-[6px] border text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg',
                        bg.kind === 'image' && bg.imagePath === b.path ? 'border-fg ring-1 ring-fg' : 'border-line-strong'
                      )}
                    >
                      <span className="block aspect-video" style={{ backgroundImage: `url(${imageUrlForPath(b.path)})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                      {/* A theme shows its wordmark; everything else says what it is. The
                          drawn backgrounds are dark and similar at this size, and an
                          unlabelled tile is not a choice anyone can make. */}
                      {BRAND_THEMES.some((t) => t.id === b.id) ? (
                        <span className="flex h-9 items-center px-2" style={{ background: PACK_PLATE_INK }}>
                          <BannerMark className="h-4 w-full" />
                        </span>
                      ) : b.id === 'omarchy' ? (
                        <span className="block px-2 py-1 text-xl" aria-hidden="true" style={{ fontFamily: '"Omarchy Brand"' }}>
                          {'\ue900'}
                        </span>
                      ) : (
                        <span className="block truncate px-2 py-1.5 text-[11px] text-fg-dim">{b.name}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <FolderBackgrounds selected={bg.kind === 'image' ? bg.imagePath : undefined} onPick={(imagePath) => set('background', { kind: 'image', imagePath, lettering: false })} />
        {themeLettering && (
          <Row label={themeLettering.label} hint="Drawn in the space around the recording, so it hides if the recording fills the frame.">
            <Toggle checked={bg.lettering === true} onChange={(lettering) => set('background', { lettering })} label={themeLettering.label} />
          </Row>
        )}
        {themeLettering && bg.lettering === true && (
          <Row label="Position">
            <Segmented<LetteringPosition>
              full={false}
              size="sm"
              value={bg.letteringPosition ?? 'top-left'}
              onChange={(letteringPosition) => set('background', { letteringPosition })}
              options={[
                { value: 'top-left', label: 'Top left' },
                { value: 'top', label: 'Top', title: 'Top centre' },
                { value: 'bottom', label: 'Bottom', title: 'Bottom centre' }
              ]}
            />
          </Row>
        )}
        <SliderField label="Background blur" value={bg.blur ?? 0} min={0} max={60} step={1} onChange={(blur) => set('background', { blur })} format={(v) => `${v}px`} />
        <Segmented<Project['background']['kind']>
          value={bg.kind}
          onChange={(kind) => {
            if (kind === 'gradient' && bg.colors.length < 2) set('background', { kind, colors: [bg.colors[0] ?? '#5b6cff', '#c86dd7'] })
            else if (kind === 'solid') set('background', { kind, colors: [bg.kind === 'solid' ? (bg.colors[0] ?? '#39445f') : '#39445f'], angle: 0 })
            else set('background', { kind })
          }}
          options={[
            { value: 'gradient', label: 'Gradient' },
            { value: 'solid', label: 'Solid' },
            { value: 'image', label: 'Image' }
          ]}
        />
        {bg.kind === 'gradient' && (
          <>
            <div className="grid grid-cols-5 gap-1.5">
              {GRADIENT_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  title={p.name}
                  aria-label={`Preset ${p.name}`}
                  onClick={() => set('background', { colors: [...p.colors], angle: p.angle })}
                  className={cx(
                    'aspect-square rounded-[6px] border transition-transform duration-100 hover:scale-105',
                    preset?.name === p.name ? 'border-fg ring-1 ring-fg' : 'border-line-strong'
                  )}
                  style={{ background: `linear-gradient(${p.angle}deg, ${p.colors[0]}, ${p.colors[1]})` }}
                />
              ))}
            </div>
            <Row label="Colors">
              <ColorField label="Start color" value={bg.colors[0] ?? '#000000'} onChange={(c) => set('background', { colors: [c, bg.colors[1] ?? c] })} />
            </Row>
            <Row label="">
              <ColorField label="End color" value={bg.colors[1] ?? bg.colors[0] ?? '#000000'} onChange={(c) => set('background', { colors: [bg.colors[0] ?? c, c] })} />
            </Row>
            <SliderField label="Angle" value={bg.angle} min={0} max={360} step={1} onChange={(angle) => set('background', { angle })} format={(v) => `${v}°`} />
          </>
        )}
        {bg.kind === 'solid' && (
          <>
            <div className="grid grid-cols-5 gap-1.5">
              {SOLID_PRESETS.map((solid) => (
                <button
                  key={solid.name}
                  type="button"
                  title={solid.name}
                  aria-label={`Solid ${solid.name}`}
                  onClick={() => set('background', { colors: [solid.color], angle: 0 })}
                  className={cx(
                    'aspect-square rounded-[6px] border transition-transform duration-100 hover:scale-105',
                    solidPreset?.name === solid.name ? 'border-fg ring-1 ring-fg' : 'border-line-strong'
                  )}
                  style={{ background: solid.color }}
                />
              ))}
            </div>
            <Row label="Custom">
              <ColorField label="Color" value={bg.colors[0] ?? '#39445f'} onChange={(c) => set('background', { colors: [c], angle: 0 })} />
            </Row>
          </>
        )}
        {bg.kind === 'image' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                icon={<ImageIcon size={13} />}
                onClick={async () => {
                  const path = await window.polish.pickImage()
                  if (path) set('background', { imagePath: path })
                }}
              >
                Choose image
              </Button>
              {bg.imagePath && (
                <>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-muted" title={bg.imagePath}>
                    {baseName(bg.imagePath)}
                  </span>
                  <button type="button" className="text-fg-dim hover:text-fg" aria-label="Remove image" onClick={() => set('background', { imagePath: undefined })}>
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
            {!bg.imagePath && <div className="text-[11.5px] text-fg-dim">Until an image is chosen the first color fills the background.</div>}
            <Row label="Fallback color">
              <ColorField label="Fallback color" value={bg.colors[0] ?? '#000000'} onChange={(c) => set('background', { colors: [c, ...bg.colors.slice(1)] })} />
            </Row>
          </div>
        )}
      </Section>

      {/* Frame -------------------------------------------------------------- */}
      <Section title="Frame">
        <SliderField label="Padding" value={project.frame.padding} min={0} max={0.3} step={0.005} onChange={(padding) => set('frame', { padding })} format={pct} />
        <SliderField label="Screen size" value={project.frame.size} min={0.5} max={1.5} step={0.01} onChange={(size) => set('frame', { size })} format={pct} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-fg-dim">Screen size {pct(project.frame.size)}</span>
          <Button size="sm" variant="ghost" disabled={project.frame.size === 1} onClick={() => set('frame', { size: 1 })}>
            Reset 100%
          </Button>
        </div>
        <SliderField label="Corner radius" value={project.frame.radius} min={0} max={64} step={1} onChange={(radius) => set('frame', { radius })} format={(v) => `${v} px`} />
        <SliderField label="Shadow" value={project.frame.shadow} min={0} max={1} step={0.01} onChange={(shadow) => set('frame', { shadow })} format={pct} />
        <SliderField label="Horizontal position" value={project.frame.offsetX} min={-0.5} max={0.5} step={0.01} onChange={(offsetX) => set('frame', { offsetX })} format={pct} />
        <SliderField label="Vertical position" value={project.frame.offsetY} min={-0.5} max={0.5} step={0.01} onChange={(offsetY) => set('frame', { offsetY })} format={pct} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-fg-dim">Position {pct(project.frame.offsetX)}, {pct(project.frame.offsetY)}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={project.frame.offsetX === 0 && project.frame.offsetY === 0}
            onClick={() => set('frame', { offsetX: 0, offsetY: 0 })}
          >
            Reset center
          </Button>
        </div>
      </Section>

      {/* Mockup ------------------------------------------------------------- */}
      <Section title="Mockup" right={project.mockup.kind !== 'none' ? <Chip tone="ok">On</Chip> : undefined}>
        <Segmented<MockupKind>
          value={project.mockup.kind}
          onChange={(kind) => set('mockup', { kind })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'browser', label: 'Browser' },
            { value: 'macos', label: 'macOS' },
            { value: 'phone', label: 'Phone' }
          ]}
        />
        {project.mockup.kind !== 'none' && (
          <div className="flex flex-col gap-2.5">
            <Row label="Appearance">
              <Segmented<MockupTheme>
                full={false}
                size="sm"
                value={project.mockup.theme}
                onChange={(theme) => set('mockup', { theme })}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' }
                ]}
              />
            </Row>
            <Row label="Shell color">
              <ColorField label="Mockup shell color" value={project.mockup.color} onChange={(color) => set('mockup', { color })} />
            </Row>
            <SliderField label="Corner radius" value={project.mockup.radius} min={0} max={64} step={1} onChange={(radius) => set('mockup', { radius })} format={(v) => `${v} px`} />
            <SliderField
              label={project.mockup.kind === 'phone' ? 'Bezel' : 'Header'}
              value={project.mockup.headerSize}
              min={project.mockup.kind === 'phone' ? 0.025 : 0.045}
              max={project.mockup.kind === 'phone' ? 0.14 : 0.18}
              step={0.005}
              onChange={(headerSize) => set('mockup', { headerSize })}
              format={pct}
            />
            <div className="rounded-[8px] border border-line bg-bg-0 px-2.5 py-2 text-[11px] text-fg-dim">
              The mockup is rendered by the same frame pipeline used for preview, thumbnails and exports.
            </div>
          </div>
        )}
      </Section>

      {/* Entrance ----------------------------------------------------------- */}
      <Section title="Entrance">
        <Row label="Style">
          <Segmented<AnimationStyle>
            value={project.animation.style}
            onChange={(style) => set('animation', { style })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'fade', label: 'Fade' },
              { value: 'rise', label: 'Rise' },
              { value: 'scale', label: 'Scale' }
            ]}
          />
        </Row>
        {project.animation.style !== 'none' && (
          <>
            <SliderField label="Duration" value={project.animation.durationSec} min={0} max={2} step={0.05} onChange={(durationSec) => set('animation', { durationSec })} format={(v) => `${v.toFixed(2)} s`} />
            <SliderField label="Strength" value={project.animation.strength} min={0} max={1} step={0.01} onChange={(strength) => set('animation', { strength })} format={pct} />
          </>
        )}
      </Section>

      {/* Cursor ------------------------------------------------------------- */}
      <Section title="Cursor">
        <p className="text-[11px] text-fg-muted">If your recording already includes the system pointer, set Size to Hidden to avoid drawing a second pointer.</p>
        <Row label="Style">
          <Segmented<Project['cursor']['style']>
            full={false}
            size="sm"
            value={project.cursor.style}
            onChange={(style) => set('cursor', { style })}
            options={[
              { value: 'agent', label: 'Agent' },
              { value: 'halo', label: 'Halo' },
              { value: 'star', label: 'Star' },
              { value: 'arrow', label: 'Arrow' },
              { value: 'hand', label: 'Hand' },
              { value: 'bobbing', label: 'Bobbing' },
              { value: 'dot', label: 'Dot' },
              ...BRAND_CURSORS.map((c) => ({ value: c.style, label: c.label, title: c.title }))
            ]}
          />
        </Row>
        {(project.cursor.style === 'agent' || project.cursor.style === 'halo' || project.cursor.style === 'star') && (
          <Row label="Colour">
            <ColorField
              value={project.cursor.color ?? (project.cursor.style === 'halo' ? '#ffffff' : project.cursor.style === 'star' ? STAR_POINTER_COLOR : AGENT_POINTER_COLOR)}
              onChange={(color) => set('cursor', { color })}
            />
          </Row>
        )}
        <SliderField label="Size" value={project.cursor.size} min={0} max={3} step={0.05} onChange={(size) => set('cursor', { size })} format={(v) => (v === 0 ? 'Hidden' : `${v.toFixed(2)}x`)} />
        <SliderField label="Spotlight" value={project.cursor.spotlight ?? 0} min={0} max={1} step={0.05} onChange={(spotlight) => set('cursor', { spotlight })} format={(v) => (v === 0 ? 'Off' : pct(v))} />
        <SliderField label="Smoothing" value={project.cursor.smoothing} min={0} max={1} step={0.01} onChange={(smoothing) => set('cursor', { smoothing })} format={pct} />
        <SliderField label="Glide" value={project.cursor.glide ?? 0} min={0} max={1} step={0.01} onChange={(glide) => set('cursor', { glide })} format={pct} />
        <p className="text-[11px] leading-[1.4] text-fg-muted">Glide slows fast pointer moves into calm, even ones that still land on every click. Smoothing only removes jitter.</p>
        <SliderField
          label="Click timing"
          value={project.cursor.syncSec ?? 0}
          min={SYNC_MIN_SEC}
          max={SYNC_MAX_SEC}
          step={0.05}
          onChange={(syncSec) => set('cursor', { syncSec })}
          format={(v) => (v === 0 ? 'As recorded' : `${v > 0 ? '+' : ''}${v.toFixed(2)} s`)}
        />
        <p className="text-[11px] leading-[1.4] text-fg-muted">
          If the screen reacts after the click, move this up until the click lands as the button changes. It moves the pointer, clicks and zooms together.
        </p>
        {pointerHasOwnClick(project.cursor.style) ? (
          <p className="text-[11px] leading-[1.4] text-fg-muted">
            {project.cursor.style === 'halo' ? 'Halo tightens on each click' : 'Star throws sparkles on each click'}, so click ripples and bounce are off for it.
          </p>
        ) : (
          <>
            <Row label="Click ripples">
              <Toggle checked={project.cursor.ripple} onChange={(ripple) => set('cursor', { ripple })} label="Click ripples" />
            </Row>
            <Row label="Click bounce"><Toggle checked={project.cursor.bounce ?? false} onChange={(bounce) => set('cursor', { bounce })} label="Click bounce" /></Row>
          </>
        )}
        <Row label="Loop cursor"><Toggle checked={project.cursor.loop ?? false} onChange={(loop) => set('cursor', { loop })} label="Loop cursor" /></Row>
        <SliderField label="Cursor sway" value={project.cursor.sway ?? 0} min={0} max={1} step={0.05} onChange={(sway) => set('cursor', { sway })} format={pct} />
        <SliderField label="Motion trail" value={project.cursor.motionBlur ?? 0} min={0} max={1} step={0.05} onChange={(motionBlur) => set('cursor', { motionBlur })} format={pct} />
        <Row label="Fade when idle" hint="Hides the drawn pointer while it rests; movement or a click brings it back.">
          <Toggle
            checked={(project.cursor.idleHideSec ?? 0) > 0}
            label="Fade when idle"
            onChange={(on) => set('cursor', { idleHideSec: on ? DEFAULT_IDLE_HIDE_SEC : 0 })}
          />
        </Row>
        {(project.cursor.idleHideSec ?? 0) > 0 && (
          <SliderField
            label="Fade after"
            value={project.cursor.idleHideSec ?? DEFAULT_IDLE_HIDE_SEC}
            min={0.5}
            max={6}
            step={0.5}
            onChange={(idleHideSec) => set('cursor', { idleHideSec })}
            format={(v) => `${v.toFixed(1)}s`}
          />
        )}
        <Row label="Click sounds" hint="A tick on every mouse press, in preview and export">
          <Toggle
            checked={clickSound.enabled}
            label="Click sounds"
            onChange={(enabled) => {
              set('cursor', { clickSound: { ...clickSound, enabled } })
              if (enabled) playClick(clickSound.style, clickSound.volume * (project.audio.masterVolume ?? 1))
            }}
          />
        </Row>
        {clickSound.enabled && (
          <>
            <Row label="Sound">
              <Segmented<ClickSoundStyle>
                full={false}
                size="sm"
                value={clickSound.style}
                onChange={(style) => {
                  set('cursor', { clickSound: { ...clickSound, style } })
                  playClick(style, clickSound.volume * (project.audio.masterVolume ?? 1))
                }}
                options={[...CLICK_SOUND_STYLES]}
              />
            </Row>
            <SliderField
              label="Click volume"
              value={clickSound.volume}
              min={0}
              max={1}
              step={0.05}
              onChange={(volume) => set('cursor', { clickSound: { ...clickSound, volume } })}
              format={pct}
            />
          </>
        )}
      </Section>

      {/* Zoom --------------------------------------------------------------- */}
      <Section
        title="Zoom"
        right={<Toggle checked={project.zoom.enabled} onChange={(enabled) => set('zoom', { enabled })} label="Zoom enabled" />}
      >
        <div className={cx('flex flex-col gap-2.5', !project.zoom.enabled && 'opacity-45 pointer-events-none')}>
          <Row label="Automatic zoom" hint="Follows click clusters">
            <Toggle checked={project.zoom.auto} onChange={(auto) => set('zoom', { auto })} label="Automatic zoom" />
          </Row>
          <div className="grid grid-cols-4 gap-1.5">
            {ZOOM_TEMPLATES.map((t) => {
              const active = matchZoomTemplate(project.zoom)?.id === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  title={t.blurb}
                  aria-label={`Zoom template ${t.name}`}
                  onClick={() => onProject((p) => applyZoomTemplate(p, t.id))}
                  className={cx(
                    'rounded-[6px] border px-1 py-1.5 text-[11px] transition-colors duration-100',
                    active ? 'border-fg bg-bg-3 text-fg' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {t.name}
                </button>
              )
            })}
          </div>
          <SliderField label="Default scale" value={project.zoom.scale} min={1.2} max={4} step={0.1} onChange={(scale) => set('zoom', { scale })} format={(v) => `${v.toFixed(1)}x`} />
          <SliderField label="Ease" value={project.zoom.easeSec ?? 0.6} min={0.15} max={1.2} step={0.05} onChange={(easeSec) => set('zoom', { easeSec })} format={(v) => `${v.toFixed(2)} s`} />
          <SliderField label="Follow cursor" value={project.zoom.follow ?? 0.35} min={0} max={1} step={0.05} onChange={(follow) => set('zoom', { follow })} format={pct} />
          <Row label="Zoom sounds" hint="A soft whoosh as the camera zooms in, out and pans">
            <Toggle
              checked={zoomSound.enabled}
              label="Zoom sounds"
              onChange={(enabled) => {
                set('zoom', { sound: { ...zoomSound, enabled } })
                if (enabled) playZoomSound('in', project.zoom.easeSec ?? 0.6, zoomSound.volume * (project.audio.masterVolume ?? 1), 0, zoomSound.style)
              }}
            />
          </Row>
          {zoomSound.enabled && (
            <Row label="Whoosh style">
              <Select<ZoomSoundStyle>
                value={zoomSound.style ?? 'classic'}
                options={[{ value: 'asmr', label: 'Soft / ASMR' }, { value: 'classic', label: 'Original' }]}
                onChange={(style) => {
                  set('zoom', { sound: { ...zoomSound, style } })
                  playZoomSound('in', project.zoom.easeSec ?? 0.6, zoomSound.volume * (project.audio.masterVolume ?? 1), 0, style)
                }}
              />
            </Row>
          )}
          {zoomSound.enabled && (
            <SliderField
              label="Zoom sound volume"
              value={zoomSound.volume}
              min={0}
              max={1}
              step={0.05}
              onChange={(volume) => set('zoom', { sound: { ...zoomSound, volume } })}
              format={pct}
            />
          )}
          <Row label="Unified 3D frame" hint="Tilt the frame and video together; older projects keep their original look">
            <Toggle checked={project.zoom.perspective === 'unified'} onChange={(enabled) => set('zoom', { perspective: enabled ? 'unified' : 'legacy' })} label="Unified 3D frame" />
          </Row>
          <Row label="Motion" hint="Cinematic mixes tilts and drifts">
            <Segmented<'zoom' | 'cinematic' | 'punch' | 'smart'>
              full={false}
              size="sm"
              value={project.zoom.motion ?? 'cinematic'}
              onChange={(motion) => set('zoom', { motion })}
              options={[
                { value: 'zoom', label: 'Zoom' },
                { value: 'cinematic', label: 'Cinematic' },
                { value: 'punch', label: 'Punch' },
                { value: 'smart', label: 'Smart' }
              ]}
            />
          </Row>
          <div className="flex items-center gap-2 text-[11.5px] text-fg-dim">
            <Chip tone="info">{autoCount} auto</Chip>
            <Chip tone="warn">{manualCount} manual</Chip>
            {project.zoom.removedAuto.length > 0 && (
              <button type="button" onClick={onRestoreAuto} className="ml-auto flex items-center gap-1 text-accent hover:text-accent-hover">
                <Undo size={12} /> Restore {project.zoom.removedAuto.length} removed
              </button>
            )}
          </div>

          {selected ? (
            <SegmentEditor segment={selected} duration={duration} region={region} onPatch={(p) => onSegmentPatch(selected, p)} onDelete={() => onSegmentDelete(selected)} onClose={() => onSelect(null)} />
          ) : (
            <div className="rounded-[8px] border border-dashed border-line px-3 py-2.5 text-[11.5px] text-fg-dim">
              Click an empty spot on the zoom lane to add a manual zoom at the pointer. Click a block to edit it, <Kbd>Del</Kbd> removes it.
            </div>
          )}
        </div>
      </Section>

      {/* Webcam ------------------------------------------------------------- */}
      <Section
        title="Webcam"
        right={<Toggle checked={project.webcam.enabled} disabled={!files.webcam} onChange={(enabled) => set('webcam', { enabled })} label="Webcam enabled" />}
      >
        {!files.webcam ? (
          <div className="text-[11.5px] text-fg-dim">No webcam was recorded with this clip.</div>
        ) : (
          <div className={cx('flex flex-col gap-2.5', !project.webcam.enabled && 'opacity-45 pointer-events-none')}>
            <Row label="Corner" hint={project.webcam.place ? 'Placed by hand; pick a corner to snap back' : undefined}>
              <Segmented<WebcamCorner>
                full={false}
                size="sm"
                value={project.webcam.place ? ('' as WebcamCorner) : project.webcam.corner}
                onChange={(corner) => set('webcam', { corner, place: undefined })}
                options={[
                  { value: 'tl', label: 'TL', title: 'Top left' },
                  { value: 'tr', label: 'TR', title: 'Top right' },
                  { value: 'bl', label: 'BL', title: 'Bottom left' },
                  { value: 'br', label: 'BR', title: 'Bottom right' }
                ]}
              />
            </Row>
            <SliderField label="Size" value={project.webcam.size} min={0.1} max={0.45} step={0.01} onChange={(size) => set('webcam', { size })} format={pct} />
            {/* Starting from the corner it is in, so the first nudge does not jump it across the frame. */}
            <SliderField label="Across" value={webcamPlace.x} min={0} max={1} step={0.01} onChange={(x) => set('webcam', { place: { ...webcamPlace, x } })} format={pct} />
            <SliderField label="Down" value={webcamPlace.y} min={0} max={1} step={0.01} onChange={(y) => set('webcam', { place: { ...webcamPlace, y } })} format={pct} />
            <SliderField label="Margin" value={project.webcam.margin ?? WEBCAM_INSET} min={0} max={WEBCAM_MAX_MARGIN} step={0.005} onChange={(margin) => set('webcam', { margin })} format={pct} />
            <SliderField label="Shadow" value={project.webcam.shadow ?? 1} min={0} max={1} step={0.05} onChange={(shadow) => set('webcam', { shadow })} format={(v) => (v === 0 ? 'Off' : pct(v))} />
            <Row label="Mirror"><Toggle checked={project.webcam.mirror ?? false} onChange={(mirror) => set('webcam', { mirror })} label="Mirror webcam" /></Row>
            <Row label="React to zoom"><Toggle checked={project.webcam.reactive ?? false} onChange={(reactive) => set('webcam', { reactive })} label="React to zoom" /></Row>
            <Row label="Round">
              <Toggle checked={project.webcam.round} onChange={(round) => set('webcam', { round })} label="Round webcam" />
            </Row>

            {/* Framing, backdrop and lighting. `look` is absent on projects saved
                before it existed, so every read falls back to the default. */}
            <SliderField
              label="Zoom"
              value={look.zoom}
              min={1}
              max={3}
              step={0.05}
              onChange={(zoom) => setLook({ zoom })}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <SliderField label="Pan across" value={look.offsetX} min={-1} max={1} step={0.02} onChange={(offsetX) => setLook({ offsetX })} format={signed} />
            <SliderField label="Pan up / down" value={look.offsetY} min={-1} max={1} step={0.02} onChange={(offsetY) => setLook({ offsetY })} format={signed} />

            <Row label="Backdrop" hint={look.backdrop === 'none' ? undefined : 'Needs the person segmenter'}>
              <Segmented
                full={false}
                size="sm"
                value={look.backdrop}
                onChange={(backdrop) => setLook({ backdrop })}
                options={[
                  { value: 'none' as const, label: 'Room' },
                  { value: 'blur' as const, label: 'Blur' },
                  { value: 'color' as const, label: 'Colour' }
                ]}
              />
            </Row>
            {look.backdrop === 'blur' && (
              <SliderField label="Blur" value={look.blur} min={4} max={48} step={1} onChange={(blur) => setLook({ blur })} format={(v) => `${Math.round(v)} px`} />
            )}
            {look.backdrop === 'color' && (
              <Row label="Colour">
                <input
                  type="color"
                  aria-label="Backdrop colour"
                  className="h-7 w-12 cursor-pointer rounded-[6px] border border-line bg-bg-2"
                  value={look.color}
                  onChange={(e) => setLook({ color: e.target.value })}
                />
              </Row>
            )}

            <SliderField label="Key light" value={look.light} min={0} max={1} step={0.02} onChange={(light) => setLook({ light })} format={pct} />
            {look.light > 0 && (
              <SliderField
                label="Light from"
                value={look.lightAngle}
                min={0}
                max={359}
                step={1}
                onChange={(lightAngle) => setLook({ lightAngle })}
                format={(v) => `${Math.round(v)}°`}
              />
            )}
            <SliderField label="Rim light" value={look.rim} min={0} max={1} step={0.02} onChange={(rim) => setLook({ rim })} format={pct} />
            <SliderField label="Exposure" value={look.exposure} min={-1} max={1} step={0.02} onChange={(exposure) => setLook({ exposure })} format={signed} />
            <SliderField label="Contrast" value={look.contrast} min={0.6} max={1.8} step={0.02} onChange={(contrast) => setLook({ contrast })} format={(v) => `${v.toFixed(2)}×`} />
          </div>
        )}
      </Section>

      <div data-section="Layers">{children}</div>

      <Section title="Captions" right={project.captions?.enabled && project.captions.cues.length ? <Chip tone="ok">On</Chip> : undefined}>
        <CaptionsPanel
          project={project}
          onProject={onProject}
          folder={files.folder}
          duration={duration}
          sources={[...(props.audioUrls?.mic ? (['mic'] as const) : []), ...(props.audioUrls?.system ? (['system'] as const) : [])]}
        />
      </Section>

      {/* Audio -------------------------------------------------------------- */}
      <Section title="Audio">
        <MusicShelf
          disabled={duration <= 0 || (project.audioRegions?.length ?? 0) >= 30}
          onAdd={(path) => onProject((p) => ({ ...p, audioRegions: [...(p.audioRegions ?? []), { id: crypto.randomUUID(), path, start: p.trim.start, end: p.trim.end || duration, offset: 0, volume: 0.5 }] }))}
        />
        {(project.audioRegions ?? []).map((r) => {
          const patch = (value: Partial<typeof r>) => onProject((p) => ({ ...p, audioRegions: (p.audioRegions ?? []).map((a) => a.id === r.id ? { ...a, ...value } : a) }))
          return <div key={r.id} className="flex flex-col gap-2 rounded border border-line p-2">
            <span className="truncate text-[11px]">{baseName(r.path)}</span>
            <NumberField ariaLabel="Audio start" value={r.start} min={0} max={r.end - 0.1} step={0.1} suffix="s" onChange={(start) => patch({ start })} />
            <NumberField ariaLabel="Audio end" value={r.end} min={r.start + 0.1} max={duration} step={0.1} suffix="s" onChange={(end) => patch({ end })} />
            <NumberField ariaLabel="Audio source offset" value={r.offset} min={0} step={0.1} suffix="s" onChange={(offset) => patch({ offset })} />
            <SliderField label="Volume" value={r.volume} min={0} max={1} step={0.05} onChange={(volume) => patch({ volume })} format={pct} />
            <Button size="sm" onClick={() => onProject((p) => ({ ...p, audioRegions: (p.audioRegions ?? []).filter((a) => a.id !== r.id) }))}>Remove audio</Button>
          </div>
        })}
        <Row label="Microphone" hint={files.mic ? undefined : 'Not recorded'} disabled={!files.mic}>
          <Toggle checked={project.audio.mic} disabled={!files.mic} onChange={(mic) => set('audio', { mic })} label="Microphone" />
        </Row>
        {files.mic && project.audio.mic && (
          <SliderField label="Mic volume" value={project.audio.micVolume} min={0} max={1} step={0.01} onChange={(micVolume) => set('audio', { micVolume })} format={pct} />
        )}
        <Row label="System audio" hint={files.system ? undefined : 'Not recorded'} disabled={!files.system}>
          <Toggle checked={project.audio.system} disabled={!files.system} onChange={(system) => set('audio', { system })} label="System audio" />
        </Row>
        {files.system && project.audio.system && (
          <SliderField label="System volume" value={project.audio.systemVolume} min={0} max={1} step={0.01} onChange={(systemVolume) => set('audio', { systemVolume })} format={pct} />
        )}
        <SliderField label="Master volume" value={project.audio.masterVolume} min={0} max={1} step={0.01} onChange={(masterVolume) => set('audio', { masterVolume })} format={pct} />
      </Section>
    </div>
  )
})

const CAMERA_STYLE_OPTIONS: Array<{ value: CameraStyle; label: string }> = [
  { value: 'zoom', label: 'Zoom' },
  { value: 'tilt-left', label: 'Tilt from left' },
  { value: 'tilt-right', label: 'Tilt from right' },
  { value: 'tilt-up', label: 'Tilt from top' },
  { value: 'tilt-down', label: 'Tilt from bottom' },
  { value: 'drift', label: 'Drift in' },
  { value: 'punch', label: 'Punch' },
  { value: 'spring', label: 'Spring zoom' },
  { value: 'pan-left', label: 'Pan left' },
  { value: 'pan-right', label: 'Pan right' },
  { value: 'orbit', label: 'Orbit angle' }
]

function SegmentEditor({
  segment,
  duration,
  region,
  onPatch,
  onDelete,
  onClose
}: {
  segment: ZoomSegment
  duration: number
  region: { width: number; height: number }
  onPatch: (patch: SegmentPatch) => void
  onDelete: () => void
  onClose: () => void
}) {
  const manual = segment.source === 'manual'
  return (
    <div className={cx('fade-in flex flex-col gap-2.5 rounded-[8px] border p-2.5', manual ? 'border-manual/40 bg-manual-soft/40' : 'border-auto/40 bg-auto-soft/40')}>
      <div className="flex items-center gap-2">
        <Chip tone={manual ? 'warn' : 'info'}>{manual ? 'Manual' : 'Auto'}</Chip>
        <span className="font-mono text-[11px] tabular-nums text-fg-muted">
          {formatTime(segment.start)} to {formatTime(segment.end)}
        </span>
        <button type="button" className="ml-auto text-fg-dim hover:text-fg" onClick={onClose} aria-label="Deselect segment">
          <X size={13} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
          Start
          <NumberField ariaLabel="Segment start" value={segment.start} min={0} max={Math.max(0, segment.end - 0.3)} step={0.1} suffix="s" onChange={(start) => onPatch({ start })} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
          End
          <NumberField ariaLabel="Segment end" value={segment.end} min={segment.start + 0.3} max={Number.isFinite(duration) ? duration : undefined} step={0.1} suffix="s" onChange={(end) => onPatch({ end })} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
          Focus X
          <NumberField ariaLabel="Focus X" value={segment.x} min={0} max={Math.max(0, region.width)} step={1} suffix="px" onChange={(x) => onPatch({ x: clampFocus({ x, y: segment.y }, region).x })} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
          Focus Y
          <NumberField ariaLabel="Focus Y" value={segment.y} min={0} max={Math.max(0, region.height)} step={1} suffix="px" onChange={(y) => onPatch({ y: clampFocus({ x: segment.x, y }, region).y })} />
        </label>
      </div>
      <SliderField label="Zoom scale" value={segment.scale} min={1.2} max={4} step={0.1} onChange={(scale) => onPatch({ scale })} format={(v) => `${v.toFixed(1)}x`} />
      <Row label="Style">
        <Select<CameraStyle>
          ariaLabel="Camera style"
          className="w-[150px]"
          value={segment.style ?? 'zoom'}
          onChange={(style) => onPatch({ style })}
          options={CAMERA_STYLE_OPTIONS}
        />
      </Row>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10.5px] tabular-nums text-fg-dim">
          focus {Math.round(segment.x)}, {Math.round(segment.y)}
        </span>
        <Button size="sm" variant="danger" icon={<Trash size={12} />} onClick={onDelete}>
          {manual ? 'Delete' : 'Remove'}
        </Button>
      </div>
      {!manual && <div className="text-[11px] text-fg-dim">Editing an automatic zoom turns it into a manual one.</div>}
    </div>
  )
}
