import { BRAND_CURSORS } from '../../brand'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_CURSOR_SKIN, type AppSettings, type CursorMode, type CursorSkin, type RecordingState, type SourceInfo, type StartRecordingRequest } from '../../shared/ipc'
import { useMediaDevices } from '../hooks/useMediaDevices'
import { describeScreenSize, describeSource, displayIdOf, type RecordSource } from '../lib/sources'
import { Camera, ChevronDown, ChevronRight, Mic, Record, Refresh, Region, Screen, Speaker, Spinner, Warning, WindowIcon } from './icons'
import { Button, Chip, Count, Eyebrow, IconButton, Kbd, Row, Segmented, Select, Toggle, cx, type ChipTone } from './ui'
import { ShortcutSettings } from './ShortcutSettings'
import { PlanPanel } from './PlanPanel'
import { applyPlan } from '../lib/plan-apply'
import { formatTime } from '../lib/time'
import { takeLookOf, type RecordPlan } from '../../shared/record-plan'
import { defaultLook } from '../../shared/presets'
import { DEFAULT_SHORTCUTS, shortcutLabel } from '../../shared/shortcuts'

interface RecordSettings {
  mic: string
  webcam: string
  system: boolean
  fps: 30 | 60
}

const SETTINGS_KEY = 'polish.record.v1'
/** 'auto' = first available device; '' = off by choice. */
const DEFAULT_SETTINGS: RecordSettings = { mic: '', webcam: 'auto', system: true, fps: 30 }

function loadSettings(): RecordSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<RecordSettings>
    return { ...DEFAULT_SETTINGS, ...parsed, fps: parsed.fps === 60 ? 60 : 30 }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function RecordPanel({ recording, refreshKey }: { recording: RecordingState; refreshKey: number }) {
  const isLinux = navigator.userAgent.includes('Linux')
  const [sources, setSources] = useState<SourceInfo[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [loadingSources, setLoadingSources] = useState(false)
  const [selection, setSelection] = useState<RecordSource | null>(null)
  const [showWindows, setShowWindows] = useState(false)
  const [settings, setSettings] = useState<RecordSettings>(loadSettings)
  const [starting, setStarting] = useState(false)
  // The length of an applied plan. Every Record press honours it until a take
  // lands: with the plan's own button and the panel's Record stacked together,
  // pressing the second recorded a 30-second plan for two minutes.
  const [plannedSec, setPlannedSec] = useState<number | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  // Pointer behaviour lives in settings.json, not localStorage: the hotkey, the
  // tray and the CLI all start recordings without this panel ever mounting.
  const [app, setApp] = useState<AppSettings | null>(null)
  const devices = useMediaDevices()
  // Whether takes here are cursor-free; decides which Linux guidance is true.
  const [cursorFree, setCursorFree] = useState(false)
  useEffect(() => {
    void window.polish.captureCapabilities().then((c) => setCursorFree(c.cursorFree)).catch(() => setCursorFree(false))
  }, [])

  useEffect(() => {
    void window.polish
      .getSettings()
      .then(setApp)
      .catch(() => setApp(null))
  }, [])

  const patchApp = useCallback((patch: Partial<AppSettings>) => {
    setApp((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.polish
      .saveSettings(patch)
      .then(setApp)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // storage unavailable: settings simply do not persist
    }
  }, [settings])

  const loadSources = useCallback(async () => {
    setLoadingSources(true)
    try {
      const list = await window.polish.listSources()
      setSources(list)
      setSourcesError(null)
      setSelection((sel) => {
        if (sel) return sel
        const first = list.find((s) => s.kind === 'screen')
        return first ? { kind: 'screen', displayId: displayIdOf(first) } : null
      })
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingSources(false)
    }
  }, [])

  useEffect(() => {
    void loadSources()
  }, [loadSources, refreshKey])

  // Ask for mic and camera once so the dropdowns fill in without a click.
  const askedRef = useRef(false)
  useEffect(() => {
    if (devices.needsPermission && !askedRef.current && !devices.requesting) {
      askedRef.current = true
      void devices.requestPermission()
    }
  }, [devices])

  const screens = useMemo(() => (sources ?? []).filter((s) => s.kind === 'screen'), [sources])
  const windows = useMemo(() => (sources ?? []).filter((s) => s.kind === 'window'), [sources])
  const [previews, setPreviews] = useState<Record<string, string>>({})

  // Pictures cost a screenshot per window, so they are fetched only while the
  // list is open, and dropped when the window set changes.
  const windowIds = windows.map((w) => w.id).join('|')
  useEffect(() => {
    if (!showWindows || windows.length === 0) return
    let live = true
    void window.polish
      .windowPreviews(windows.map((w) => w.id))
      .then((map) => { if (live) setPreviews(map) })
      .catch(() => undefined)
    return () => { live = false }
  }, [showWindows, windowIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Device ids saved earlier may no longer exist (unplugged). Fall back to "off".
  const micValue = devices.mics.some((d) => d.deviceId === settings.mic) ? settings.mic : ''
  // Whether the starred look styles captions, which are made from the microphone.
  const [lookWantsCaptions, setLookWantsCaptions] = useState(false)
  useEffect(() => {
    const check = () => void window.polish.listLooks().then((shelf) => setLookWantsCaptions(!!defaultLook(shelf)?.captions.style), () => undefined)
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  const camValue =
    settings.webcam === 'auto' ? (devices.cams[0]?.deviceId ?? '') : devices.cams.some((d) => d.deviceId === settings.webcam) ? settings.webcam : ''

  // Keep main in sync so Ctrl+Shift+R and the tray record with these same inputs.
  // Persist the raw choice: 'auto' survives as 'auto' so a device list that has
  // not loaded yet can never save the camera as "off" behind the user's back.
  useEffect(() => {
    window.polish.saveRecordDefaults({ mic: settings.mic, webcam: settings.webcam, system: settings.system, fps: settings.fps })
  }, [settings.mic, settings.webcam, settings.system, settings.fps])

  const idle = recording.status === 'idle'
  const canStart = idle && selection !== null && !starting

  const regionDisplayId = (): number => {
    if (selection && selection.kind !== 'window') return selection.displayId
    return screens[0] ? displayIdOf(screens[0]) : 0
  }

  /**
   * Start with the panel's choices, or with `planned` ones: "Record this plan"
   * sets the panel and starts in the same click, before React has re-rendered
   * the state it just set, so it passes what it chose.
   */
  const start = async (planned?: { selection: RecordSource; mic: string; system: boolean; fps: 30 | 60; maxDurationSec: number }) => {
    const chosen = planned?.selection ?? selection
    if (!chosen) return
    setStarting(true)
    setStartError(null)
    const source: StartRecordingRequest['source'] =
      chosen.kind === 'region'
        ? // A zero-size region asks main to show the overlay picker on that display.
          { kind: 'region', displayId: chosen.displayId, region: { x: 0, y: 0, width: 0, height: 0, scale: 1 } }
        : chosen
    const mic = planned ? planned.mic : micValue
    const request: StartRecordingRequest = {
      source,
      mic: mic ? { deviceId: mic } : null,
      system: planned?.system ?? settings.system,
      webcam: camValue ? { deviceId: camValue } : null,
      fps: planned?.fps ?? settings.fps,
      ...(planned ? { maxDurationSec: planned.maxDurationSec } : plannedSec !== null ? { maxDurationSec: plannedSec } : {})
    }
    try {
      await window.polish.startRecording(request)
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  // A plan is for one take: once a recording has been written, Record is ordinary again.
  const lastStatus = useRef(recording.status)
  useEffect(() => {
    if (lastStatus.current === 'finalizing' && recording.status === 'idle') setPlannedSec(null)
    lastStatus.current = recording.status
  }, [recording.status])

  const deviceLabel = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`

  // A plan sets the source, inputs and pointer here, and the cards, background
  // and shape on the next take. Returns what it could not match, to show.
  const setUpPlan = async (plan: RecordPlan) => {
    const result = applyPlan(plan, sources ?? [], { mic: settings.mic, system: settings.system, fps: settings.fps })
    if (result.selection) setSelection(result.selection)
    // 'auto' means the first microphone; the panel stores real device ids.
    const mic = result.choices.mic === 'auto' ? (devices.mics[0]?.deviceId ?? '') : result.choices.mic
    const notes = [...result.notes]
    if (result.choices.mic === 'auto' && !mic) notes.push('The plan wants the microphone, but none was found.')
    setSettings((s) => ({ ...s, ...result.choices, mic }))
    if (result.cursorSkin) patchApp({ cursorSkin: result.cursorSkin })
    await window.polish.setNextTakeLook(takeLookOf(plan))
    setPlannedSec(plan.durationSec)
    return { notes, selection: result.selection, mic, system: result.choices.system, fps: result.choices.fps }
  }

  const applyRecordingPlan = async (plan: RecordPlan): Promise<string[]> => (await setUpPlan(plan)).notes

  /** Set the plan up and record it: counts in, records its length, stops itself. */
  const recordRecordingPlan = async (plan: RecordPlan): Promise<string[]> => {
    const set = await setUpPlan(plan)
    if (!set.selection) return [...set.notes, 'Nothing to record: no screen was found.']
    void start({ selection: set.selection, mic: set.mic, system: set.system, fps: set.fps, maxDurationSec: plan.durationSec })
    return set.notes
  }

  const status: { tone: ChipTone; label: string } =
    recording.status === 'recording'
      ? { tone: 'rec', label: 'Recording' }
      : recording.status === 'countdown'
        ? { tone: 'accent', label: 'Counting in' }
        : recording.status === 'picking'
          ? { tone: 'accent', label: 'Choose source' }
          : sourcesError
            ? { tone: 'danger', label: 'No sources' }
            : sources === null
              ? { tone: 'idle', label: 'Loading' }
              : canStart
                ? { tone: 'ok', label: 'Ready' }
                : { tone: 'warn', label: 'Pick a source' }

  return (
    <aside className="record-panel flex shrink-0 flex-col bg-bg-1">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="text-[13.5px] font-semibold text-fg">Record</h2>
        <Chip tone={status.tone}>{status.label}</Chip>
        <div className="ml-auto">
          <IconButton label="Refresh sources" onClick={() => void loadSources()} disabled={loadingSources}>
            {loadingSources ? <Spinner size={14} /> : <Refresh size={14} />}
          </IconButton>
        </div>
      </div>

      <div className="capture-settings min-h-0">
        {/* Source ------------------------------------------------------------ */}
        <div className="capture-sources flex flex-col gap-2 px-4 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <Eyebrow>Source</Eyebrow>
            {sources && <Count>{screens.length + windows.length}</Count>}
          </div>
          {sourcesError && (
            <div className="flex items-center gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
              <Warning size={13} /> {sourcesError}
            </div>
          )}
          {sources === null && !sourcesError && (
            <div className="flex h-20 items-center justify-center text-fg-dim">
              <Spinner size={16} />
            </div>
          )}
          {screens.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {screens.map((s) => {
                const id = displayIdOf(s)
                const active = selection?.kind === 'screen' && selection.displayId === id
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelection({ kind: 'screen', displayId: id })}
                    className={cx(
                      'group flex flex-col overflow-hidden rounded-[8px] border text-left transition-colors duration-100',
                      active ? 'border-accent bg-bg-2' : 'border-line bg-bg-2 hover:border-line-strong hover:bg-bg-3'
                    )}
                  >
                    <div className="relative aspect-video w-full bg-bg-0">
                      {s.thumbnail ? (
                        <img src={s.thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
                      ) : (
                        <div className="flex h-full items-center justify-center text-fg-dim">
                          <Screen size={18} />
                        </div>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {active && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent" />}
                        <span className={cx('truncate text-[12px]', active ? 'text-accent' : 'text-fg')}>{s.name}</span>
                      </div>
                      <div className="font-mono text-[10.5px] tabular-nums text-fg-dim">{describeScreenSize(s)}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          {sources && screens.length === 0 && <div className="text-[12px] text-fg-dim">No displays reported.</div>}

          <button
            type="button"
            onClick={() => setSelection({ kind: 'region', displayId: regionDisplayId() })}
            className={cx(
              'flex h-9 items-center gap-2.5 rounded-[8px] border px-3 text-left transition-colors duration-100',
              selection?.kind === 'region' ? 'border-accent bg-bg-2 text-fg' : 'border-line bg-bg-2 text-fg hover:border-line-strong hover:bg-bg-3'
            )}
          >
            <Region size={15} className={selection?.kind === 'region' ? 'text-accent' : 'text-fg-muted'} />
            <span className="text-[12.5px]">Region</span>
            <span className="ml-auto text-[11px] text-fg-dim">drag on screen after Record</span>
          </button>

          <div className="rounded-[8px] border border-line bg-bg-2">
            <button
              type="button"
              onClick={() => setShowWindows((v) => !v)}
              className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[12.5px] text-fg hover:bg-bg-3"
              aria-expanded={showWindows}
            >
              <WindowIcon size={15} className="text-fg-muted" />
              Window
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-dim">
                <Count>{windows.length}</Count>
                {showWindows ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            </button>
            {showWindows && (
              <div className="max-h-[380px] overflow-y-auto border-t border-line py-1">
                {windows.length === 0 && <div className="px-3 py-2 text-[12px] text-fg-dim">No windows found.</div>}
                {windows.map((w) => {
                  const active = selection?.kind === 'window' && selection.sourceId === w.id
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setSelection({ kind: 'window', sourceId: w.id })}
                      title={w.detail ? `${w.name}\n${w.detail}` : w.name}
                      aria-pressed={active}
                      className={cx(
                        'flex w-full items-center gap-2.5 px-3 text-left text-[12px]',
                        previews[w.id] || w.thumbnail || w.detail ? 'min-h-[80px] py-1.5' : 'h-8',
                        active ? 'rail bg-bg-3 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'
                      )}
                    >
                      {previews[w.id] ?? w.thumbnail ? (
                        <img
                          src={previews[w.id] ?? w.thumbnail}
                          alt={`Preview of ${w.name}`}
                          className={cx('h-[68px] w-[112px] shrink-0 rounded-[4px] border bg-bg-0 object-contain', active ? 'border-accent' : 'border-line')}
                          draggable={false}
                        />
                      ) : (
                        <span className={cx('flex shrink-0 items-center justify-center rounded-[3px] bg-bg-3', w.detail ? 'h-[68px] w-[112px]' : 'h-5 w-8')}>
                          <WindowIcon size={12} />
                        </span>
                      )}
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate">{w.name}</span>
                        {w.detail && <span className="truncate text-[11px] text-fg-dim">{w.detail}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Inputs ------------------------------------------------------------ */}
        <div className="capture-inputs flex flex-col gap-2.5 border-t border-line px-4 pt-3 pb-3">
          <div className="flex items-center">
            <Eyebrow>Inputs</Eyebrow>
            {devices.needsPermission && (
              <button
                type="button"
                onClick={() => void devices.requestPermission()}
                disabled={devices.requesting}
                className="ml-auto text-[11px] font-medium normal-case tracking-normal text-accent hover:text-accent-hover disabled:opacity-50"
              >
                {devices.requesting ? 'Asking' : 'Allow mic and camera'}
              </button>
            )}
          </div>
          {devices.error && <div className="text-[11.5px] text-danger">{devices.error}</div>}

          <Row
            label={<span className="flex items-center gap-2"><Mic size={14} className="text-fg-muted" /> Microphone</span>}
            hint={lookWantsCaptions && !micValue ? 'Your starred look has captions, and they are made from the microphone.' : undefined}
          >
            <Select
              ariaLabel="Microphone"
              className="w-[150px]"
              value={micValue}
              onChange={(v) => setSettings((s) => ({ ...s, mic: v }))}
              options={[{ value: '', label: 'Off' }, ...devices.mics.map((d, i) => ({ value: d.deviceId, label: deviceLabel(d, i, 'Microphone') }))]}
            />
          </Row>
          <Row label={<span className="flex items-center gap-2"><Camera size={14} className="text-fg-muted" /> Webcam</span>}>
            <Select
              ariaLabel="Webcam"
              className="w-[150px]"
              value={camValue}
              onChange={(v) => setSettings((s) => ({ ...s, webcam: v }))}
              options={[{ value: '', label: 'Off' }, ...devices.cams.map((d, i) => ({ value: d.deviceId, label: deviceLabel(d, i, 'Camera') }))]}
            />
          </Row>
          <Row label={<span className="flex items-center gap-2"><Speaker size={14} className="text-fg-muted" /> System audio</span>} hint={isLinux ? 'PipeWire output monitor · pw-cat + pactl' : 'Windows loopback'}>
            <Toggle checked={settings.system} onChange={(v) => setSettings((s) => ({ ...s, system: v }))} label="System audio" />
          </Row>
          <Row label="Frame rate">
            <Segmented
              full={false}
              size="sm"
              value={settings.fps}
              onChange={(v) => setSettings((s) => ({ ...s, fps: v }))}
              options={[
                { value: 30 as const, label: '30 fps' },
                { value: 60 as const, label: '60 fps' }
              ]}
            />
          </Row>
          <Row
            label="Pointer"
            hint={
              isLinux
                ? cursorFree
                  ? 'Recorded without your cursor, so the style below is the pointer in playback and export.'
                  : 'Your system cursor is recorded into the video, so pointer styles do not show. Install gpu-screen-recorder to record without it.'
                : app?.cursorMode === 'system'
                  ? 'Real system cursor, recorded as is'
                  : 'Replaced by a clean pointer only you see'
            }
          >
            <Segmented
              full={false}
              size="sm"
              value={app?.cursorMode ?? 'overlay'}
              disabled={!app || isLinux}
              onChange={(v: CursorMode) => patchApp({ cursorMode: v })}
              options={[
                { value: 'overlay' as const, label: 'Polished', title: 'Hide the real cursor and draw a clean one. Best looking output.' },
                { value: 'system' as const, label: 'System', title: 'Keep the real cursor. Text and resize shapes stay, nothing to track.' }
              ]}
            />
          </Row>
          {app?.cursorMode !== 'system' && (
            <Row label="Pointer style">
              <Select
                ariaLabel="Pointer style"
                className="w-[150px]"
                value={app?.cursorSkin ?? DEFAULT_CURSOR_SKIN}
                disabled={!app}
                onChange={(v: CursorSkin) => patchApp({ cursorSkin: v })}
                options={[
                  { value: 'agent', label: 'Agent' },
                  { value: 'halo', label: 'Halo' },
                  { value: 'star', label: 'Star' },
                  { value: 'arrow', label: 'Arrow' },
                  { value: 'hand', label: 'Hand' },
                  { value: 'bobbing', label: 'Bobbing' },
                  { value: 'dot', label: 'Dot' },
                  ...BRAND_CURSORS.flatMap((c) => (c.liveSkin ? [{ value: c.liveSkin, label: c.label }] : []))
                ]}
              />
            </Row>
          )}
        </div>
      </div>

      {app && <div className="px-4 pb-3"><ShortcutSettings settings={app} disabled={recording.status !== 'idle'} onSaved={setApp} /></div>}

      {/* Plan --------------------------------------------------------------- */}
      <PlanPanel sources={sources} hasMic={devices.mics.length > 0} hasWebcam={devices.cams.length > 0} onApply={applyRecordingPlan} onRecord={recordRecordingPlan} onClear={() => { setPlannedSec(null); void window.polish.setNextTakeLook(null) }} disabled={!idle || starting} />
      {/* Start ------------------------------------------------------------- */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-4">
        {startError && (
          <div className="flex items-center gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
            <Warning size={13} /> {startError}
          </div>
        )}
        <Button variant="record" size="lg" icon={starting ? <Spinner size={14} /> : <Record size={14} />} disabled={recording.status !== 'recording' && recording.status !== 'countdown' && recording.status !== 'picking' && !canStart} onClick={() => {
          if (recording.status === 'recording' || recording.status === 'countdown' || recording.status === 'picking') {
            void window.polish.stopRecording().catch((error) => setStartError(String(error)))
          } else void start()
        }}>
          {idle ? (plannedSec !== null ? `Record · stops at ${formatTime(plannedSec, { fraction: false })}` : 'Record') : recording.status === 'recording' ? 'Stop recording' : recording.status === 'countdown' ? 'Cancel recording' : recording.status === 'picking' ? 'Cancel selection' : 'Busy'}
        </Button>
        {isLinux && (
          <p className="border-l border-line-strong pl-2.5 text-[11px] leading-[1.45] text-fg-muted">
            {cursorFree
              ? selection?.kind === 'window'
                ? 'Records the window where it sits on screen, with no share dialog. Keep it on this workspace and fully visible while recording; if it is not, the share dialog opens instead.'
                : 'Records directly, with no share dialog.'
              : selection?.kind === 'window'
                ? 'Select your named window above, then choose that SAME window in the system share dialog. This keeps click zoom aligned when the window moves. Do not select a region or another same-sized window.'
                : 'For a whole monitor, select that monitor in the share picker. To record one app, choose Window above.'}{' '}
            Zoom and cursor effects appear after recording.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 text-[11px] text-fg-dim">
          <span className="truncate font-mono">{describeSource(selection, sources ?? [])}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Kbd>{shortcutLabel(app?.shortcuts?.record ?? DEFAULT_SHORTCUTS.record)}</Kbd>
          </span>
        </div>
      </div>
    </aside>
  )
}
