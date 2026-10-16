// Recording lifecycle: source resolution, countdown, capture host, chunk
// writing, input log, finalization, crash tolerance.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  BrowserWindow,
  ipcMain,
  nativeImage,
  session as electronSession,
  type DesktopCapturerSource,
  type Display,
  type IpcMainInvokeEvent
} from 'electron'
import {
  CAPTURE,
  type CaptureChunk,
  type CaptureFileKey,
  type CaptureStartMessage,
  type CaptureStartedMessage,
  type GuideView,
  type RecordingState,
  type StartRecordingRequest
} from '@shared/ipc'
import type { CaptureRegion, RecordingEvents } from '@shared/types'
import { hideSystemCursor, restoreSystemCursor, isCursorHidden } from './win/cursor-manager'
import { getCursorMode, getCursorSkin, getDefaultLook } from './settings'
import { InputLogger } from './input-logger'
import { TIMED_OUT, withTimeout, withTimeoutOrThrow } from './with-timeout'
import { recordingsRoot } from './media-protocol'
import { formatFolderName } from './naming'
import { foregroundWindowTitle } from './win/foreground-title'
import { recordingTitle } from './recording-title'
import { serializeProject } from './project-io'
import { newRecordingProject } from './new-recording-project'
import { AutoStop, autoStopMs } from './auto-stop'
import type { PlanTakeLook } from '@shared/record-plan'
import { bitrateFor, cropForRegion, regionForDisplay } from './region-math'
import { displayById, findPortalSource, findScreenSource, findWindowSource, listsThroughPortal, windowRegion } from './sources'
import { resolveCaptureTarget, shouldTrackPortalInput, snapshotCaptureTargets, windowOnScreen, type HyprClient, type HyprMonitor, type IdentifyWindow } from './linux/capture-target'
import { GsrRecording, findGsr, gsrArgs, planNativeCapture, type GsrMonitor } from './linux/gsr'
import { alignFile, remuxFile, remuxTimeoutMs, rescaleEvents, videoSize } from './linux/gsr-finish'
import { FINGERPRINT_CAPTURE_TIMEOUT_MS, FINGERPRINT_CAPTURE_WIDTH, windowJpeg } from './linux/window-previews'
import { FINGERPRINT_HEIGHT, FINGERPRINT_WIDTH, fingerprintFromPixels, pickByFingerprint } from '@shared/frame-fingerprint'
import { cursorBakedIntoCapture } from './capture-cursor'
import { moveGuide, startGuide, type GuideState } from '@shared/recording-guide'
import { cancelRegionPicker, createCaptureWindow, loadPage } from './windows'
import { SystemAudioRecorder } from './linux/system-audio'

export const FILE_FOR_KEY: Record<CaptureFileKey, string> = {
  screen: 'screen.mp4',
  mic: 'mic.mp4',
  system: 'system.mp4',
  webcam: 'webcam.mp4'
}
const CAPTURE_KEYS = new Set<string>(Object.keys(FILE_FOR_KEY))

export const FINALIZE_TIMEOUT_MS = 10_000
/** Longest any single finalizing step may take before the take is saved without it. */
export const FINALIZE_STEP_TIMEOUT_MS = 20_000

/** What gpu-screen-recorder writes; remuxed to screen.mp4 when the take ends. */
export const NATIVE_SCREEN_FILE = 'screen.mkv'

/**
 * What a finished take left on disk: a playable screen.mp4, only gsr's
 * screen.mkv (the remux failed or ran out of time), or nothing worth keeping.
 */
export type KeptTake = 'mp4' | 'mkv' | null

export function keptTake(folder: string, size: (file: string) => number = fileSize): KeptTake {
  if (size(path.join(folder, FILE_FOR_KEY.screen)) > 0) return 'mp4'
  if (size(path.join(folder, NATIVE_SCREEN_FILE)) > 0) return 'mkv'
  return null
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// Wayland's portal picker is interactive and may sit open while the user finds
// the right window. Do not misreport a slow selection as a capture failure.
export const START_TIMEOUT_MS = 120_000
export const LOAD_TIMEOUT_MS = 20_000
export const COUNTDOWN_SECONDS = 3


/** Short human label for the HUD: which display, window or region is being captured. */
export function describeSource(request: StartRecordingRequest, display: Display, source: { name: string } | null, region: CaptureRegion): string {
  const size = `${region.width}\u00d7${region.height}`
  if (request.source.kind === 'window') return `Window: ${source?.name ?? 'Selected window'}`.slice(0, 80)
  if (request.source.kind === 'region') return `Region ${size}`
  const name = display.label && display.label.trim() ? display.label.trim() : `Display ${display.id}`
  return `${name} \u00b7 ${size}`
}

const LOW_DISK_BYTES = 2 * 1024 ** 3

/**
 * Below this a take is not started at all.
 *
 * The warning above used to be the only guard, and it only warned. On a full
 * drive the recording began, the HUD showed a small note, and nothing could be
 * written - the one failure a recorder must not have, because the person thinks
 * they are capturing the moment and is not. A refusal they can act on beats a
 * take that silently was never there.
 */
export const MIN_FREE_BYTES_TO_RECORD = 256 * 1024 ** 2

/** Bytes free to this user on the drive holding `dir`, or null when it cannot be told. */
export function freeBytes(dir: string, statfs: (p: string) => { bavail: number | bigint; bsize: number | bigint } = fs.statfsSync): number | null {
  try {
    const st = statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    // statfs unsupported, or the folder does not exist yet.
    return null
  }
}

export type DiskVerdict = { action: 'record' } | { action: 'warn'; free: string } | { action: 'refuse'; free: string }

/** What free space means for starting a take. Unknown space never blocks: that would be worse than the problem. */
export function diskVerdict(free: number | null): DiskVerdict {
  if (free === null) return { action: 'record' }
  const shown = free < 1024 ** 3 ? `${Math.max(0, Math.round(free / 1024 ** 2))} MB` : `${(free / 1024 ** 3).toFixed(1)} GB`
  if (free < MIN_FREE_BYTES_TO_RECORD) return { action: 'refuse', free: shown }
  if (free < LOW_DISK_BYTES) return { action: 'warn', free: shown }
  return { action: 'record' }
}

/** Human free-space string when the recordings drive has under 2 GB, else null. Best effort. */
export function lowDiskWarning(folder: string): string | null {
  const verdict = diskVerdict(freeBytes(folder))
  return verdict.action === 'record' ? null : verdict.free
}

class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

/** A take whose screen gpu-screen-recorder records natively, without the cursor. */
interface NativeCapture {
  gsr: GsrRecording
  /** screen.mkv; remuxed to screen.mp4 when the take ends. */
  output: string
  region: CaptureRegion
  /** Wall-clock ms of gsr's first frame: the take's t = 0. */
  startedAt: number
  /** How much later the capture host (mic, webcam) started than the screen. */
  hostOffsetMs: number
}

interface Active {
  native: NativeCapture | null
  systemAudio: SystemAudioRecorder | null
  folder: string
  region: CaptureRegion
  display: Display
  source: DesktopCapturerSource | null
  startMessage: CaptureStartMessage
  window: BrowserWindow | null
  handles: Map<CaptureFileKey, number>
  finalized: Set<CaptureFileKey>
  startedAt: number | null
  /** Foreground window when capture began; becomes project.title. */
  title: string | null
  /** HUD label: what is being recorded. */
  label: string
  lowDisk: string | null
  sourceKind: StartRecordingRequest['source']['kind']
  paused: boolean
  hostGone: boolean
  aborted: boolean
  /** Handles closed; late chunks are dropped rather than reopening (and truncating) files. */
  closed: boolean
  countdownTimer: NodeJS.Timeout | null
  /** Ends a planned take after its length; null for an ordinary one. */
  autoStop?: AutoStop | null
  startedResolve: ((m: CaptureStartedMessage) => void) | null
  startedReject: ((e: Error) => void) | null
  finalizedWaiters: Array<() => void>
}

export type StateListener = (state: RecordingState) => void


export class RecordingSession {
  /**
   * Cards, background and shape a recording plan chose for the next take.
   * Kept until a take actually lands, so a failed start does not lose it.
   */
  nextTakeLook: PlanTakeLook | null = null
  systemAudioEncoder: (() => string) | null = null
  private current: RecordingState = { status: 'idle' }
  private readonly listeners = new Set<StateListener>()
  private active: Active | null = null
  private stopping: Promise<void> | null = null
  private readonly logger = new InputLogger()
  private guide: GuideState | null = null
  private readonly guideListeners = new Set<(view: GuideView | null) => void>()

  /** Recording finished and files are on disk. */
  onFinished: ((folder: string) => void) | null = null
  /** Fatal failure while starting or recording (already cleaned up). */
  onError: ((message: string) => void) | null = null
  /** Non-fatal: an optional input (mic, webcam) was skipped or swapped. */
  onWarning: ((message: string) => void) | null = null
  lastFolder: string | null = null

  get state(): RecordingState {
    return this.current
  }

  get isActive(): boolean {
    return this.active !== null
  }

  /** Device id of the webcam being recorded, or null. */
  get activeWebcam(): string | null {
    return this.active?.startMessage.webcam?.deviceId ?? null
  }

  /** What is being recorded: a whole screen, a window or a drawn region. */
  get activeSourceKind(): StartRecordingRequest['source']['kind'] | null {
    return this.active?.sourceKind ?? null
  }

  get activeDisplay(): Display | null {
    return this.active?.display ?? null
  }

  /** Physical-px region being recorded, and whether it is a user-drawn region. */
  get activeRegion(): { region: CaptureRegion; isRegion: boolean } | null {
    return this.active ? { region: this.active.region, isRegion: this.active.sourceKind === 'region' } : null
  }

  /** The recording guide of a planned take while it records, or null. */
  get guideView(): GuideView | null {
    if (!this.guide || !this.active) return null
    return { steps: this.guide.steps, index: this.guide.index, onScreen: this.active.sourceKind !== 'screen' }
  }

  onGuideChange(listener: (view: GuideView | null) => void): () => void {
    this.guideListeners.add(listener)
    return () => this.guideListeners.delete(listener)
  }

  /** Move the guide: a click inside the recording, or its Next or Back button. Marks or unmarks the step in the input log. */
  moveGuide(move: 'click' | 'next' | 'back', tMs = this.logger.clockMs): void {
    if (!this.guide || tMs === null) return
    const next = moveGuide(this.guide, move, tMs)
    if (next === this.guide) return
    if (next.index > this.guide.index && this.logger.markStep() === null) return
    if (next.index < this.guide.index) this.logger.unmarkStep()
    this.guide = next
    this.emitGuide()
  }

  private emitGuide(): void {
    const view = this.guideView
    for (const l of this.guideListeners) {
      try {
        l(view)
      } catch (err) {
        console.warn('[recording] guide listener failed', err)
      }
    }
  }

  private endGuide(): void {
    this.logger.onPress = null
    if (!this.guide) return
    this.guide = null
    this.emitGuide()
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  beginPicking(): void {
    if (this.current.status === 'idle') this.setState({ status: 'picking' })
  }

  endPicking(): void {
    if (this.current.status === 'picking') this.setState({ status: 'idle' })
  }

  async start(request: StartRecordingRequest): Promise<void> {
    if (this.active || (this.current.status !== 'idle' && this.current.status !== 'picking')) {
      throw new Error(`Cannot start a recording while ${this.current.status}`)
    }
    const { display, source, region, crop } = await this.resolveSource(request)
    // The editor is hidden during countdown, which can cause a tiled Wayland
    // window to resize before the portal stream begins. Preserve the geometry
    // the user saw before that layout change so the selected stream still maps.
    const portalTargetsBeforePicker = listsThroughPortal() ? await snapshotCaptureTargets() : null
    // Before anything is created, so a refused take leaves no empty folder behind.
    const verdict = diskVerdict(freeBytes(recordingsRoot()))
    if (verdict.action === 'refuse') {
      throw new Error(
        `Not enough free space to record: ${verdict.free} left on the drive that holds your recordings. ` +
          'Free some space, or click the folder path in the Library to record onto another drive, then try again.'
      )
    }
    const folder = path.join(recordingsRoot(), formatFolderName(new Date()))
    fs.mkdirSync(folder, { recursive: true })
    const startMessage: CaptureStartMessage = {
      crop,
      fps: request.fps,
      videoBitrate: bitrateFor(region.width, region.height, request.fps),
      mic: request.mic,
      system: request.system,
      webcam: request.webcam
    }
    const rec: Active = {
      native: null,
      systemAudio: null,
      folder,
      region,
      display,
      source,
      startMessage,
      window: null,
      handles: new Map(),
      finalized: new Set(),
      title: null,
      label: describeSource(request, display, source, region),
      lowDisk: lowDiskWarning(folder),
      sourceKind: request.source.kind,
      startedAt: null,
      paused: false,
      hostGone: false,
      aborted: false,
      closed: false,
      countdownTimer: null,
      startedResolve: null,
      startedReject: null,
      finalizedWaiters: []
    }
    this.active = rec
    this.lastFolder = folder

    try {
      // Load the host while the countdown runs so the user does not wait twice.
      const win = createCaptureWindow()
      rec.window = win
      win.webContents.on('render-process-gone', (_e, details) => {
        console.error('[recording] capture host gone', details.reason)
        this.onHostGone(rec)
      })
      win.on('closed', () => {
        rec.window = null
        this.onHostGone(rec)
      })
      win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[recording] capture host failed to load ${url}: ${code} ${desc}`))
      win.webContents.on('did-finish-load', () => console.log('[recording] capture host loaded'))
      const loaded = withTimeoutOrThrow(loadPage(win, 'capture'), LOAD_TIMEOUT_MS, 'Capture host page did not load')

      await this.countdown(rec)
      await loaded
      if (rec.aborted) throw new Cancelled()

      // Linux: record the screen natively, without the cursor, when it can be;
      // the capture host then records only the microphone and webcam.
      if (await this.startNative(rec, request, display)) startMessage.screen = false
      if (rec.aborted) throw new Cancelled()

      electronSession.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
        const grant = (selected: DesktopCapturerSource): void => {
          // System audio loopback exists only on Windows (electron.d.ts: 'currently only supported on Windows').
          callback(request.system && process.platform === 'win32' ? { video: selected, audio: 'loopback' } : { video: selected })
        }
        if (source) {
          grant(source)
          return
        }
        // On Linux/PipeWire, source discovery is the portal picker. It must run
        // in response to getDisplayMedia so the portal has a live media request
        // to authorize, and it must offer both screens and windows.
        findPortalSource(request.source.kind).then(grant).catch((err) => {
          console.error('[recording] portal source selection failed', err)
          // Electron's documented cancellation value is null even though its
          // TypeScript declaration currently accepts only Streams.
          callback(null as never)
        })
      })
      // 'system' mode keeps the real Windows pointer: every context shape works
      // and there is no tracking lag, at the cost of it being baked into the video.
      if (getCursorMode() === 'overlay') hideSystemCursor()

      const started = new Promise<CaptureStartedMessage>((resolve, reject) => {
        rec.startedResolve = resolve
        rec.startedReject = reject
        setTimeout(() => reject(new Error(`Capture host did not start within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS)
      })
      win.webContents.send(CAPTURE.start, startMessage)
      const info = await started
      if (rec.aborted) throw new Cancelled()
      rec.startedAt = rec.native ? rec.native.startedAt : info.startedAt
      if (rec.native) rec.native.hostOffsetMs = info.startedAt - rec.native.startedAt
      if (request.system && process.platform === 'linux' && this.systemAudioEncoder) {
        const audio = new SystemAudioRecorder()
        rec.systemAudio = audio
        try {
          await audio.start(path.join(folder, FILE_FOR_KEY.system), this.systemAudioEncoder(), rec.startedAt,
            (message) => this.onWarning?.(message))
        } catch (error) {
          await audio.stop().catch(() => undefined)
          rec.systemAudio = null
          this.onWarning?.(`System audio was not recorded: ${String(error)}. Check PipeWire, pw-cat and pactl.`)
        }
        if (rec.aborted) throw new Cancelled()
      }
      // A take with no microphone is a legitimate choice, but a silent voice track is the
      // kind of thing that is only discovered in the editor, so say it at the start.
      if (!request.mic) this.onWarning?.('No microphone is selected, so this take records no voice. Pick one in the record panel if you want narration.')
      rec.title = recordingTitle(foregroundWindowTitle(), request.source.kind === 'window' ? 'Window recording' : 'Screen recording')
      // On Wayland the portal picker chose what the stream shows, which may not be
      // the display the panel asked for. Log pointer positions against that.
      let inputRegion = rec.native ? rec.native.region : region
      let trackPointer = true
      let inputNote: string | undefined
      let windowAddress: string | undefined
      let trackedWindow: HyprClient | null = null
      let trackedMonitors: HyprMonitor[] = []
      // A native take recorded exactly the rectangle it was given; nothing to discover.
      if (listsThroughPortal() && !rec.native) {
        const stream = { width: info.streamWidth, height: info.streamHeight }
        const selectedAddress = request.source.kind === 'window' && request.source.sourceId.startsWith('hypr:') ? request.source.sourceId.slice(5) : undefined
        const target = await resolveCaptureTarget(stream, region, process.env, portalTargetsBeforePicker, selectedAddress, identifyByContent(info.fingerprint))
        if (target.kind === 'window') {
          windowAddress = target.address
          // Seed the tracker so the first clicks map before the first poll lands.
          if (windowAddress) {
            const snapshot = await snapshotCaptureTargets()
            trackedWindow = snapshot?.clients.find((c) => c.address === windowAddress) ?? null
            trackedMonitors = snapshot?.monitors ?? []
          }
        }
        if (rec.aborted) throw new Cancelled()
        if (startMessage.crop) {
          // Region capture always has an explicit compositor-space rectangle;
          // retain input even if the portal describes its backing surface as
          // custom. Losing the whole log is worse than a possible small offset.
          if (!shouldTrackPortalInput(target, true)) {
            trackPointer = false
            inputNote = 'The portal described this region in a way ScreenPolish could not place on screen, so the pointer and clicks were not recorded for this take.'
          } else if (target.kind !== 'expected' && target.kind !== 'monitor') {
            this.onWarning?.('The portal could not confirm this region against a complete screen; pointer and click effects are using the ScreenPolish region coordinates.')
          }
        } else if (target.kind === 'unknown') {
          trackPointer = false
          inputNote = 'ScreenPolish could not tell which window was shared, so the pointer and clicks were not recorded and auto zoom is unavailable for this take.'
          this.onWarning?.('ScreenPolish could not tell which window was shared, so auto zoom is off for this take. This happens when another open window is exactly the same size; resize one of them slightly, or record the whole screen.')
        } else {
          if (request.source.kind === 'window' && target.kind !== 'window') {
            // The dialog decides what it shares; the panel's pick is only a request.
            this.onWarning?.('The share dialog handed over more than the window you picked, so this take covers that area and auto zoom follows the pointer across it.')
          }
          if (target.kind !== 'expected') {
            inputRegion = target.region
            rec.region = target.region
          }
        }
        console.log(`[recording] portal target: ${target.kind} ${JSON.stringify(target.region)}`)
      }
      // Prefer actual stream cursor metadata; legacy/unreported portal streams
      // retain the tracked-pointer fallback.
      this.logger.start(inputRegion, rec.startedAt, {
        cursorBaked: rec.native ? false : cursorBakedIntoCapture(process.platform, isCursorHidden(), info.cursorMode),
        cursorMode: rec.native ? 'never' : info.cursorMode,
        input: trackPointer,
        inputNote,
        windowAddress,
        window: trackedWindow,
        monitors: trackedMonitors
      })
      // A planned take with steps records with the guide: each click moves it on.
      this.guide = startGuide(this.nextTakeLook?.steps ?? [])
      if (this.guide) {
        this.logger.onPress = (t) => this.moveGuide('click', t)
        this.emitGuide()
      }
      // A partial input log means partial polish (no clicks = no auto-zoom). Say so
      // at the start of the take rather than letting the editor look broken later.
      const caps = this.logger.capabilities
      if (caps?.reason) {
        this.logger.note(`Recorded with a reduced input log: ${caps.reason}.`)
        this.onWarning?.(`Recording with a reduced input log: ${caps.reason}.`)
      }
      this.setState({ status: 'recording', folder, startedAt: rec.startedAt, paused: false, label: rec.label, lowDisk: rec.lowDisk ?? undefined })
      // A planned take stops itself once it has run its length.
      const limit = autoStopMs(request.maxDurationSec)
      if (limit !== null) {
        // Counted from the first recorded frame, not from here: setup after it
        // (audio, the input log) took about 1.5 s, and a 6-second plan came
        // out 7.5 seconds long.
        const alreadyRecorded = rec.startedAt !== null ? Math.max(0, Date.now() - rec.startedAt) : 0
        rec.autoStop = new AutoStop(Math.max(0, limit - alreadyRecorded), () => {
          if (this.active === rec) void this.stop().catch((err) => console.error('[recording] planned stop failed', err))
        })
        rec.autoStop.run()
      }
    } catch (err) {
      await this.abort(rec, err)
      if (err instanceof Cancelled) return
      throw err
    }
  }

  /** Stop and finalize. During the countdown this cancels instead. Resolves once files are written. */
  async stop(): Promise<void> {
    if (this.current.status === 'picking') {
      cancelRegionPicker()
      this.endPicking()
      return
    }
    if (this.stopping) return this.stopping
    const rec = this.active
    if (!rec) return
    if (rec.startedAt === null) {
      await this.abort(rec, new Cancelled())
      return
    }
    this.stopping = this.finish(rec).finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  togglePause(): void {
    const rec = this.active
    if (!rec || rec.startedAt === null || this.current.status !== 'recording') return
    rec.paused = !rec.paused
    if (rec.paused) rec.autoStop?.pause()
    else rec.autoStop?.run()
    rec.native?.gsr.togglePause()
    rec.systemAudio?.setPaused(rec.paused)
    if (rec.paused) this.logger.pause()
    else this.logger.resume()
    if (rec.window && !rec.window.isDestroyed()) rec.window.webContents.send(rec.paused ? CAPTURE.pause : CAPTURE.resume)
    this.setState({ status: 'recording', folder: rec.folder, startedAt: rec.startedAt, paused: rec.paused, label: rec.label, lowDisk: rec.lowDisk ?? undefined })
  }

  // --- host -> main ------------------------------------------------------------

  registerCaptureIpc(): void {
    const fromHost = (event: IpcMainInvokeEvent): Active | null => {
      const rec = this.active
      if (!rec || !rec.window || rec.window.isDestroyed()) return null
      return event.sender.id === rec.window.webContents.id ? rec : null
    }
    ipcMain.handle(CAPTURE.chunk, (event, chunk: CaptureChunk) => {
      const rec = fromHost(event)
      if (rec) this.writeChunk(rec, chunk)
    })
    ipcMain.handle(CAPTURE.started, (event, message: CaptureStartedMessage) => {
      const rec = fromHost(event)
      if (!rec) return
      console.log(`[recording] started ${message.streamWidth}×${message.streamHeight} at ${message.startedAt}`)
      rec.startedResolve?.(message)
      rec.startedResolve = null
    })
    ipcMain.handle(CAPTURE.finalized, (event, key: CaptureFileKey) => {
      const rec = fromHost(event)
      if (!rec) return
      rec.finalized.add(key)
      this.checkFinalized(rec)
    })
    ipcMain.handle(CAPTURE.warning, (event, message: string) => {
      if (!fromHost(event)) return
      console.warn(`[recording] ${message}`)
      this.onWarning?.(message)
    })
    ipcMain.handle(CAPTURE.error, (event, message: string) => {
      const rec = fromHost(event)
      if (!rec) return
      console.error('[recording] capture host error:', message)
      if (rec.startedAt === null) {
        rec.startedReject?.(new Error(message))
        rec.startedReject = null
      } else {
        // Mid-recording failure: keep whatever is on disk.
        this.onError?.(message)
        void this.stop()
      }
    })
  }

  // --- internals ---------------------------------------------------------------

  private setState(state: RecordingState): void {
    this.current = state
    for (const l of this.listeners) {
      try {
        l(state)
      } catch (err) {
        console.error('[recording] state listener threw', err)
      }
    }
  }

  private async resolveSource(request: StartRecordingRequest): Promise<{
    display: Display
    source: DesktopCapturerSource | null
    region: CaptureRegion
    crop: CaptureStartMessage['crop']
  }> {
    const src = request.source
    if (src.kind === 'window') {
      if (listsThroughPortal()) {
        const display = displayById(undefined)
        return { display, source: null, region: regionForDisplay(display), crop: null }
      }
      const source = await findWindowSource(src.sourceId)
      const display = displayById(undefined)
      const region = windowRegion(src.sourceId) ?? regionForDisplay(display)
      return { display, source, region, crop: null }
    }
    const display = displayById(src.displayId)
    const source = listsThroughPortal() ? null : await findScreenSource(display)
    const displayRegion = regionForDisplay(display)
    if (src.kind === 'region') {
      const crop = cropForRegion(src.region, displayRegion)
      const region: CaptureRegion = {
        x: displayRegion.x + crop.x,
        y: displayRegion.y + crop.y,
        width: crop.width,
        height: crop.height,
        scale: displayRegion.scale
      }
      return { display, source, region, crop }
    }
    return { display, source, region: displayRegion, crop: null }
  }

  private countdown(rec: Active): Promise<void> {
    return new Promise((resolve, reject) => {
      let seconds = COUNTDOWN_SECONDS
      const tick = (): void => {
        rec.countdownTimer = null
        if (rec.aborted) return reject(new Cancelled())
        if (seconds <= 0) return resolve()
        this.setState({ status: 'countdown', seconds })
        seconds--
        rec.countdownTimer = setTimeout(tick, 1000)
      }
      tick()
    })
  }

  private writeChunk(rec: Active, chunk: CaptureChunk): void {
    if (!CAPTURE_KEYS.has(chunk.key) || rec.closed) return
    let fd = rec.handles.get(chunk.key)
    if (fd === undefined) {
      fd = fs.openSync(path.join(rec.folder, FILE_FOR_KEY[chunk.key]), 'w+')
      rec.handles.set(chunk.key, fd)
    }
    const data = chunk.data
    const buf = Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
    let offset = 0
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset, chunk.position + offset)
    }
  }

  /**
   * Keys whose `finalized` we still need. `screen` is always expected once the
   * host reported `started`, even before its first chunk: a static screen can
   * sit under the 1 MB StreamTarget buffer until finalize() flushes it.
   */
  private pendingKeys(rec: Active): CaptureFileKey[] {
    // A native take's screen is gsr's, not the host's: only wait for what the host writes.
    const expected = new Set<CaptureFileKey>([...(rec.native ? [] : (['screen'] as const)), ...rec.handles.keys()])
    return [...expected].filter((k) => !rec.finalized.has(k))
  }

  private checkFinalized(rec: Active): void {
    if (this.pendingKeys(rec).length > 0 && !rec.hostGone) return
    const waiters = rec.finalizedWaiters.splice(0)
    for (const w of waiters) w()
  }

  private waitForFinalized(rec: Active, timeoutMs: number): Promise<void> {
    if (this.pendingKeys(rec).length === 0 || rec.hostGone) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[recording] finalize timed out; pending: ${this.pendingKeys(rec).join(', ')}`)
        resolve()
      }, timeoutMs)
      rec.finalizedWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private closeHandles(rec: Active): void {
    rec.closed = true
    for (const [key, fd] of rec.handles) {
      try {
        fs.closeSync(fd)
      } catch (err) {
        console.warn(`[recording] close ${key} failed`, err)
      }
    }
    rec.handles.clear()
  }

  private teardown(rec: Active): void {
    rec.autoStop?.cancel()
    rec.autoStop = null
    if (rec.countdownTimer) clearTimeout(rec.countdownTimer)
    rec.countdownTimer = null
    try {
      electronSession.defaultSession.setDisplayMediaRequestHandler(null)
    } catch (err) {
      console.warn('[recording] could not clear display media handler', err)
    }
    restoreSystemCursor()
    const win = rec.window
    rec.window = null
    if (win && !win.isDestroyed()) win.destroy()
    if (this.active === rec) this.active = null
  }

  /**
   * Wait for one finalizing step, and give up on it rather than on the take.
   *
   * Each of these waits on something outside this process. When one never
   * settles the whole session used to stay in `finalizing` for good: the tray
   * said "finishing…", recording was disabled because the app was not idle,
   * stopping was disabled because it was already stopping, and quitting waited
   * on the same promise — the app could only be killed. A step that hangs now
   * costs the take that step, and nothing else.
   */
  private async step<T>(work: Promise<T> | undefined, what: string, timeoutMs = FINALIZE_STEP_TIMEOUT_MS): Promise<T | undefined> {
    if (!work) return undefined
    const settled = await withTimeout(work, timeoutMs)
    if (settled === TIMED_OUT) {
      console.warn(`[recording] ${what} did not finish in ${timeoutMs} ms; saving the take without it`)
      this.onWarning?.(`${what} did not finish in time; the recording was saved without that step.`)
      return undefined
    }
    return settled
  }

  private async finish(rec: Active): Promise<void> {
    this.setState({ status: 'finalizing', folder: rec.folder })
    const audioStopped = rec.systemAudio?.stop().catch((error) => this.onWarning?.(`System audio finalization: ${String(error)}`))
    const nativeStopped = rec.native?.gsr.stop()
    this.endGuide()
    let events = this.logger.stop()
    // Everything from here to the sidecars is best effort: whatever happens,
    // the files that exist are kept and the session returns to idle.
    try {
      if (rec.window && !rec.window.isDestroyed() && !rec.hostGone) {
        rec.window.webContents.send(CAPTURE.stop)
        await this.waitForFinalized(rec, FINALIZE_TIMEOUT_MS)
      }
      this.closeHandles(rec)
      await this.step(audioStopped, 'The system audio track')
      if (rec.native) {
        await this.step(nativeStopped, 'The recorder')
        const timeout = remuxTimeoutMs(fileSize(rec.native.output), FINALIZE_STEP_TIMEOUT_MS)
        events = (await this.step(this.finishNative(rec, rec.native, events), 'Converting the take', timeout)) ?? events
      }
    } catch (err) {
      console.error('[recording] finalizing failed', err)
      this.onWarning?.(`Finishing the recording failed (${String(err)}); the take was kept as it is.`)
    }
    // A folder holding only screen.mkv is still a take: it is the one copy when
    // the remux failed, and removing it here once deleted the recording a
    // moment after the warning said it was kept.
    const kept = keptTake(rec.folder)
    if (kept) {
      try {
        fs.writeFileSync(path.join(rec.folder, 'events.json'), JSON.stringify(events))
        const projectPath = path.join(rec.folder, 'project.json')
        if (!fs.existsSync(projectPath)) {
          fs.writeFileSync(projectPath, serializeProject(newRecordingProject({ title: rec.title ?? '', fps: rec.startMessage.fps, cursorSkin: getCursorSkin(), look: this.nextTakeLook, style: getDefaultLook() })))
          // A plan applies to the take it was made for, and only once.
          this.nextTakeLook = null
        }
      } catch (err) {
        console.error('[recording] writing sidecar files failed', err)
      }
    } else {
      try {
        fs.rmSync(rec.folder, { recursive: true, force: true })
      } catch (err) {
        console.warn('[recording] could not remove empty folder', err)
      }
    }
    try {
      this.teardown(rec)
    } finally {
      // The last line of defence: idle again, whatever went wrong above.
      this.setState({ status: 'idle' })
    }
    if (kept === 'mp4') this.onFinished?.(rec.folder)
    else if (kept === 'mkv') {
      this.onError?.(
        `The recording could not be converted to MP4, so it is not in the library. Nothing was lost: it is saved as ${path.join(rec.folder, NATIVE_SCREEN_FILE)}.`
      )
    } else this.onError?.('Recording stopped before any video was written')
  }

  /** Give up on a recording that never produced a started event (or was cancelled during countdown). */
  private async abort(rec: Active, err: unknown): Promise<void> {
    if (rec.aborted) return
    rec.aborted = true
    await rec.native?.gsr.kill().catch(() => undefined)
    await rec.systemAudio?.stop().catch(() => undefined)
    rec.startedReject?.(err instanceof Error ? err : new Error(String(err)))
    rec.startedReject = null
    this.endGuide()
    if (this.logger.running) this.logger.stop()
    this.closeHandles(rec)
    this.teardown(rec)
    const screenFile = path.join(rec.folder, FILE_FOR_KEY.screen)
    const hasVideo = fs.existsSync(screenFile) && fs.statSync(screenFile).size > 0
    if (!hasVideo) {
      try {
        fs.rmSync(rec.folder, { recursive: true, force: true })
      } catch (rmErr) {
        console.warn('[recording] could not remove empty folder', rmErr)
      }
    }
    this.setState({ status: 'idle' })
    if (!(err instanceof Cancelled)) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[recording] aborted:', message)
      this.onError?.(message)
    }
  }

  /**
   * Start gpu-screen-recorder for this take, if it is installed and the source
   * is one it can record: a screen, a region, or a window wholly on one screen.
   * Otherwise, or if it fails to start, says why and returns false so the take
   * goes through the share dialog as before (with the cursor in the video).
   */
  private async startNative(rec: Active, request: StartRecordingRequest, display: Display): Promise<boolean> {
    if (process.platform !== 'linux' || !listsThroughPortal()) return false
    const bin = findGsr()
    if (!bin) {
      console.log('[recording] gpu-screen-recorder not found on PATH; using the share dialog')
      return false
    }
    const fallback = (why: string) => {
      console.warn(`[recording] native capture declined: ${why}`)
      this.onWarning?.(`Recording through the share dialog because ${why}. Your system cursor will be in the video, so pointer styles will not show.`)
      return false
    }
    // Read the layout now, after the countdown: hiding the editor can re-tile it.
    const snapshot = await snapshotCaptureTargets()
    if (!snapshot) return fallback('Hyprland did not report its monitors')
    const monitors: GsrMonitor[] = snapshot.monitors.flatMap((m) => (m.name ? [{ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale, transform: m.transform }] : []))
    const src = request.source
    let window: { x: number; y: number; width: number; height: number; title?: string } | null = null
    if (src.kind === 'window') {
      const address = src.sourceId.startsWith('hypr:') ? src.sourceId.slice(5) : null
      const client = address ? snapshot.clients.find((c) => c.address === address) : undefined
      if (!client) return fallback('the picked window could not be found')
      if (!windowOnScreen(client, snapshot.monitors)) return fallback('the window is on another workspace')
      window = { x: client.at[0], y: client.at[1], width: client.size[0], height: client.size[1], title: client.title }
    }
    const plan = planNativeCapture({ kind: src.kind, monitors, displayBounds: display.bounds, region: rec.region, window })
    if ('skip' in plan) return fallback(plan.skip)
    const output = path.join(rec.folder, NATIVE_SCREEN_FILE)
    const gsr = new GsrRecording(bin, gsrArgs({ target: plan.target, fps: request.fps, output }), output)
    try {
      const startedAt = await gsr.start()
      rec.native = { gsr, output, region: plan.region, startedAt, hostOffsetMs: 0 }
      rec.region = plan.region
      console.log(`[recording] native capture: gpu-screen-recorder -w ${plan.target}, first frame ${new Date(startedAt).toISOString()}`)
      return true
    } catch (err) {
      return fallback(`gpu-screen-recorder could not start (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  /** Remux gsr's screen.mkv to screen.mp4, line the host's tracks up with it, and fit the log to its real size. */
  private async finishNative(rec: Active, native: NativeCapture, events: RecordingEvents): Promise<RecordingEvents> {
    const ffmpeg = this.systemAudioEncoder?.()
    const screenFile = path.join(rec.folder, FILE_FOR_KEY.screen)
    if (!ffmpeg || !fs.existsSync(native.output)) return events
    try {
      await remuxFile(ffmpeg, native.output, screenFile)
      fs.rmSync(native.output, { force: true })
      fs.rmSync(`${native.output}.ts`, { force: true })
    } catch (err) {
      // Keep the mkv: it is the only copy of the take.
      this.onWarning?.(`The recording could not be converted to MP4 (${String(err)}); it is kept as screen.mkv.`)
      return events
    }
    for (const [key, kind] of [['mic', 'audio'], ['webcam', 'video']] as const) {
      try {
        if (await alignFile(ffmpeg, path.join(rec.folder, FILE_FOR_KEY[key]), kind, native.hostOffsetMs)) {
          console.log(`[recording] shifted ${key} by ${native.hostOffsetMs} ms to match the screen`)
        }
      } catch (err) {
        this.onWarning?.(`The ${key} track could not be lined up with the screen (${String(err)}); it may be ${Math.abs(native.hostOffsetMs)} ms out.`)
      }
    }
    const size = await videoSize(screenFile)
    return size ? rescaleEvents(events, size) : events
  }

  private onHostGone(rec: Active): void {
    if (this.active !== rec || rec.hostGone) return
    rec.hostGone = true
    this.checkFinalized(rec)
    if (rec.startedAt === null) {
      void this.abort(rec, new Error('The capture host closed before recording started'))
    } else if (!this.stopping) {
      console.warn('[recording] capture host died mid-recording; finalizing with what exists')
      void this.stop()
    }
  }
}

export const recordingSession = new RecordingSession()

/**
 * Tell same-sized windows apart by what they show: capture each candidate
 * small, reduce it to the same grid as the stream's first frame, and keep the
 * one that clearly matches. See shared/frame-fingerprint.ts.
 */
function identifyByContent(streamFingerprint: number[] | undefined): IdentifyWindow | undefined {
  if (!streamFingerprint) return undefined
  return async (candidates) => {
    const scored = await Promise.all(
      candidates.map(async (client) => {
        const jpeg = await windowJpeg(client, FINGERPRINT_CAPTURE_WIDTH, undefined, FINGERPRINT_CAPTURE_TIMEOUT_MS)
        if (!jpeg) return { client, fingerprint: null }
        const image = nativeImage.createFromBuffer(jpeg)
        if (image.isEmpty()) return { client, fingerprint: null }
        // toBitmap is BGRA on every platform Electron ships for.
        const bitmap = image.resize({ width: FINGERPRINT_WIDTH, height: FINGERPRINT_HEIGHT, quality: 'best' }).toBitmap()
        return { client, fingerprint: fingerprintFromPixels(bitmap, 'bgra') }
      })
    )
    const picked = pickByFingerprint(streamFingerprint, scored)
    console.log(`[recording] same-size windows: ${candidates.map((c) => c.class ?? c.address).join(', ')} -> ${picked ? picked.client.class ?? picked.client.address : 'undecided'}`)
    return picked?.client ?? null
  }
}
