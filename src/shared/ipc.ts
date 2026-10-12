// IPC contract between main, the capture host and the editor. Channel names are
// constants so a typo fails typecheck instead of silently never firing.

import type { CaptureRegion, Project, RecordingEvents, RecordingFiles, RecordingSummary } from './types'
import type { CaptionCue, CaptionsStatus } from './captions'


// ---------------------------------------------------------------------------
// Capture host  (hidden window)  <->  main

export type CaptureFileKey = 'screen' | 'mic' | 'system' | 'webcam'

export interface CaptureStartMessage {
  /**
   * false: the screen is recorded outside this host (gpu-screen-recorder on
   * Linux, without the cursor); only the microphone and webcam are recorded here.
   */
  screen?: boolean
  /** Region to crop out of the display stream, in stream pixels. null = whole stream. */
  crop: null | { x: number; y: number; width: number; height: number }
  fps: 30 | 60
  videoBitrate: number
  mic: null | { deviceId: string }
  /** Windows loopback or Linux PipeWire output monitor audio. */
  system: boolean
  webcam: null | { deviceId: string }
}

export const CAPTURE = {
  /** main -> host */
  start: 'polish:capture:start',
  stop: 'polish:capture:stop',
  pause: 'polish:capture:pause',
  resume: 'polish:capture:resume',
  /** host -> main (invoke) */
  chunk: 'polish:capture:chunk',
  started: 'polish:capture:started',
  finalized: 'polish:capture:finalized',
  error: 'polish:capture:error',
  /** host -> main: something optional (mic, webcam) was skipped */
  warning: 'polish:capture:warning'
} as const

export interface CaptureStartedMessage {
  /** Date.now() at the instant video timestamp 0 begins. */
  startedAt: number
  /** Actual stream size the crop was applied to. */
  streamWidth: number
  streamHeight: number
  cursorMode?: 'always' | 'motion' | 'never'
  /** First frame reduced to a small grey grid; tells same-sized windows apart. See shared/frame-fingerprint.ts. */
  fingerprint?: number[]
}

export interface CaptureChunk {
  key: CaptureFileKey
  position: number
  data: ArrayBuffer
}

/** API exposed to the capture page by src/preload/capture.ts as window.polishCapture */
export interface CaptureBridge {
  onStart: (handler: (message: CaptureStartMessage) => void) => void
  onStop: (handler: () => void) => void
  onPause: (handler: () => void) => void
  onResume: (handler: () => void) => void
  sendChunk: (chunk: CaptureChunk) => Promise<void>
  started: (message: CaptureStartedMessage) => Promise<void>
  finalized: (key: CaptureFileKey) => Promise<void>
  error: (message: string) => Promise<void>
  warning: (message: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Editor window  <->  main

export type ExportKind = 'mp4' | 'gif'

export interface ExportBeginRequest {
  folder: string
  kind: ExportKind
  /** Base file name without extension. */
  name: string
}

export interface ExportBeginResponse {
  exportId: string
  /** Absolute path the MP4 (or the temp MP4 for GIF) is written to. */
  path: string
}

export interface ExportEndRequest {
  audioTrackCount?: number
  audioSpeedSpans?: Array<{ start: number; end: number; rate: number }>
  /** Seconds the video runs, so the audio is padded to match (an outro card has no sound of its own). */
  durationSec?: number
  exportId: string
  /** For GIF: main converts the temp MP4 and deletes it. */
  fps?: number
  width?: number
}

export interface ExportEndResponse {
  path: string
}

export type ImageFormat = 'png' | 'jpg'

/** A rendered still (thumbnail) to write under <folder>/exports/. */
export interface SaveImageRequest {
  folder: string
  /** Base file name without extension. */
  name: string
  format: ImageFormat
  /** Encoded PNG or JPEG bytes. */
  data: ArrayBuffer
}

export interface SaveImageResponse {
  path: string
}

/** JPEG bytes to become <folder>/exports/thumb.jpg, the library cover. */
export interface SetCoverRequest {
  folder: string
  data: ArrayBuffer
}

export interface LoadedProject {
  files: RecordingFiles
  events: RecordingEvents
  project: Project
  /** Media URLs on the polish:// protocol, usable in <video src> and fetch with Range. */
  urls: { screen: string; mic?: string; system?: string; webcam?: string }
}

export const EDITOR = {
  /** main -> editor */
  open: 'polish:editor:open',
  exportProgressRequest: 'polish:editor:export-progress-request',
  /** editor -> main (invoke) */
  load: 'polish:project:load',
  save: 'polish:project:save',
  list: 'polish:recordings:list',
  reveal: 'polish:shell:reveal',
  copyFile: 'polish:shell:copy-file',
  openFile: 'polish:shell:open-file',
  dragFile: 'polish:shell:drag-file',
  openExternal: 'polish:shell:open-external',
  deleteRecording: 'polish:recordings:delete',
  exportBegin: 'polish:export:begin',
  exportChunk: 'polish:export:chunk',
  exportEnd: 'polish:export:end',
  exportAbort: 'polish:export:abort',
  exportProgress: 'polish:export:progress',
  pickImage: 'polish:dialog:pick-image',
  pickAudio: 'polish:dialog:pick-audio',
  listMusic: 'polish:music:list',
  openMusicFolder: 'polish:music:open-folder',
  listBackgrounds: 'polish:backgrounds:list',
  openBackgroundsFolder: 'polish:backgrounds:open-folder',
  saveImage: 'polish:image:save',
  setCover: 'polish:image:set-cover',
  startRecording: 'polish:recording:start',
  stopRecording: 'polish:recording:stop',
  recordingState: 'polish:recording:state',
  /** main -> editor push */
  recordingStateChanged: 'polish:recording:state-changed',
  listSources: 'polish:sources:list',
  windowPreviews: 'polish:sources:previews',
  captureCapabilities: 'polish:capture:capabilities',
  captionsStatus: 'polish:captions:status',
  planAgents: 'polish:plan:agents',
  askPlan: 'polish:plan:ask',
  setNextTakeLook: 'polish:plan:next-take',
  transcribe: 'polish:captions:transcribe',
  transcribeProgress: 'polish:captions:progress',
  listAudioDevices: 'polish:devices:audio',
  /** main -> editor push: run an export (CLI, automation) */
  exportRequest: 'polish:export:request',
  /** editor -> main (invoke): pull a request registered before the editor mounted */
  pendingExport: 'polish:export:pending',
  /** editor -> main (send): request finished or failed */
  exportRequestDone: 'polish:export:request-done',
  /** editor -> main (send): remember the panel's inputs so hotkey/tray/CLI recordings use them */
  saveRecordDefaults: 'polish:record:defaults',
  /** editor -> main (invoke): app settings */
  getSettings: 'polish:settings:get',
  saveSettings: 'polish:settings:save',
  chooseRecordingsRoot: 'polish:settings:choose-root',
  openRecordingsRoot: 'polish:settings:open-root'
} as const

/** Inputs chosen in the record panel; hotkey and tray recordings reuse them. */
/**
 * How the pointer behaves while a recording runs.
 *
 * `overlay` blanks all 13 Windows system cursors so the capture cannot see the
 * pointer, then draws a capture-excluded sprite for the user. Polished output,
 * but the user loses every context shape Windows would normally show.
 *
 * `system` leaves the real cursor alone. I-beam, resize and hand all work, there
 * is no tracking lag at all, and the price is that the raw pointer is baked into
 * the video and cannot be smoothed or restyled later.
 */
export type CursorMode = 'overlay' | 'system'

/** Sprite the overlay pointer draws. Only meaningful when cursorMode is 'overlay'. */
export type CursorSkin = 'agent' | 'halo' | 'star' | 'hand' | 'arrow' | 'arrow-dark' | 'ring' | 'dot' | 'crosshair' | 'sprite'

export const CURSOR_SKINS: readonly CursorSkin[] = ['agent', 'halo', 'star', 'hand', 'arrow', 'arrow-dark', 'ring', 'dot', 'crosshair', 'sprite']

/**
 * The hand reads as "I am pointing at this" rather than "I am a mouse", which is
 * what a demo is actually saying, and its silhouette survives being scaled up by
 * a 2x zoom better than a thin arrow does.
 */
export const DEFAULT_CURSOR_SKIN: CursorSkin = 'agent'

/** userData/settings.json */
export interface AppSettings {
  shortcuts?: import('./shortcuts').RecordingShortcuts
  /** Absolute folder every new recording is created in and the library lists. */
  recordingsRoot: string
  /** Pointer behaviour while recording. Defaults to 'overlay'. */
  cursorMode: CursorMode
  /** Overlay pointer sprite. Defaults to 'hand'. */
  cursorSkin: CursorSkin
}

export interface RecordDefaults {
  mic: string
  webcam: string
  system: boolean
  fps: 30 | 60
}

/** An export main wants the editor to run (from `polish export` / `polish clip --export`). */
export interface ExportRequest {
  requestId: string
  folder: string
  kind: ExportKind
  name: string
}

export interface ExportRequestResult {
  requestId: string
  path?: string
  error?: string
}

export type RecordingState =
  | { status: 'idle' }
  | { status: 'picking' }
  | { status: 'countdown'; seconds: number }
  | { status: 'recording'; folder: string; startedAt: number; paused: boolean; /** What is being recorded, for the HUD. */ label?: string; /** Human free-space string when the recordings drive is nearly full. */ lowDisk?: string }
  | { status: 'finalizing'; folder: string }

export interface SourceInfo {
  /** Screens: String(display.id). Windows: the desktopCapturer source id. */
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail?: string
  /** Second line under the name, such as "Chromium · Workspace 4". */
  detail?: string
  /** For screens: bounds on the virtual desktop in DIP. */
  bounds?: { x: number; y: number; width: number; height: number }
  scaleFactor?: number
  /** For screens: the Electron display id to pass in StartRecordingRequest. */
  displayId?: number
}

export interface StartRecordingRequest {
  source: { kind: 'screen'; displayId: number } | { kind: 'window'; sourceId: string } | { kind: 'region'; displayId: number; region: CaptureRegion }
  mic: null | { deviceId: string }
  system: boolean
  webcam: null | { deviceId: string }
  fps: 30 | 60
  /** Stop on its own after this many seconds of recording (a planned take). */
  maxDurationSec?: number
}

/** API exposed to the editor by src/preload/editor.ts as window.polish */
export interface MusicTrack {
  path: string
  name: string
  bytes: number
}

/** A picture from your backgrounds folder. */
export interface FolderBackground {
  path: string
  name: string
}

export interface EditorBridge {
  onOpen: (handler: (folder: string) => void) => () => void
  load: (folder: string) => Promise<LoadedProject>
  save: (folder: string, project: Project) => Promise<void>
  list: () => Promise<RecordingSummary[]>
  reveal: (path: string) => Promise<void>
  /** Put the file on the clipboard, for pasting into a chat or an upload box. */
  copyFile: (path: string) => Promise<void>
  /** Hand the file to whatever opens it by default. */
  openFile: (path: string) => Promise<void>
  /** Begin an OS drag carrying the file; the caller is inside a dragstart. */
  dragFile: (path: string) => void
  openExternal: (url: string) => Promise<void>
  deleteRecording: (folder: string) => Promise<void>
  exportBegin: (request: ExportBeginRequest) => Promise<ExportBeginResponse>
  exportChunk: (exportId: string, position: number, data: ArrayBuffer) => Promise<void>
  exportEnd: (request: ExportEndRequest) => Promise<ExportEndResponse>
  exportAbort: (exportId: string) => Promise<void>
  exportProgress: (exportId: string, fraction: number) => void
  pickImage: () => Promise<string | null>
  pickAudio: () => Promise<string | null>
  /** Tracks on the music shelf, ready to lay under a take. */
  listMusic: () => Promise<MusicTrack[]>
  /** Open the shelf in the file manager, so tracks can be dropped in. */
  openMusicFolder: () => Promise<void>
  /** Pictures in your backgrounds folder, ready to use as a background. */
  listBackgrounds: () => Promise<FolderBackground[]>
  /** Open the backgrounds folder in the file manager, creating it if needed. */
  openBackgroundsFolder: () => Promise<void>
  saveImage: (request: SaveImageRequest) => Promise<SaveImageResponse>
  setCover: (request: SetCoverRequest) => Promise<SaveImageResponse>
  startRecording: (request: StartRecordingRequest) => Promise<void>
  stopRecording: () => Promise<void>
  recordingState: () => Promise<RecordingState>
  onRecordingStateChanged: (handler: (state: RecordingState) => void) => () => void
  listSources: () => Promise<SourceInfo[]>
  /** Window pictures by source id, fetched when the window list is opened. */
  windowPreviews: (ids: string[]) => Promise<Record<string, string>>
  /** cursorFree: takes are recorded without the system cursor (gpu-screen-recorder on Linux), so pointer styles show. */
  captureCapabilities: () => Promise<{ cursorFree: boolean }>
  /** Whether the bundled speech engine and model are present on this build; `reason` says what is missing. */
  captionsStatus: () => Promise<CaptionsStatus>
  /** Agents installed here that can plan a recording. */
  planAgents: () => Promise<Array<{ id: string; name: string }>>
  /** Ask one agent for a plan; the agent is named by id, never by command. */
  askPlan: (agentId: string, context: import('./record-plan').PlanContext, history: import('./record-plan').PlanTurn[]) => Promise<{ plan: import('./record-plan').RecordPlan | null; message: string }>
  /** The cards, background and shape for the next take, or null to clear them. */
  setNextTakeLook: (look: import('./record-plan').PlanTakeLook | null) => Promise<void>
  /** Transcribe a recording's mic or system audio locally; resolves with caption cues. */
  transcribe: (folder: string, source: 'mic' | 'system') => Promise<CaptionCue[]>
  /** 0..1 while transcribe runs. Returns an unsubscribe. */
  onTranscribeProgress: (handler: (fraction: number) => void) => () => void
  onExportRequest: (handler: (request: ExportRequest) => void) => () => void
  pendingExport: (folder: string) => Promise<ExportRequest | null>
  exportRequestDone: (result: ExportRequestResult) => void
  saveRecordDefaults: (defaults: RecordDefaults) => void
  getSettings: () => Promise<AppSettings>
  /** Merge a patch into settings.json; resolves the settings as saved. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  /** Folder picker; resolves the new settings, or null when cancelled. */
  chooseRecordingsRoot: () => Promise<AppSettings | null>
  openRecordingsRoot: () => Promise<void>

}

declare global {
  interface Window {
    polish: EditorBridge
    polishCapture: CaptureBridge
    polishHud: HudBridge
    polishGhost?: GhostBridge
  }
}

// ---------------------------------------------------------------------------
// Region picker overlay window  ->  main

/** Rectangle drawn by the user, in CSS px relative to the overlay window (= DIP on its display). */
export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export const OVERLAY = {
  /** overlay -> main (send). null = cancelled. */
  done: 'polish:overlay:done'
} as const

/** API exposed to the overlay page by src/preload/overlay.ts as window.polishOverlay */
export interface OverlayBridge {
  done: (rect: OverlayRect | null) => void
}

// ---------------------------------------------------------------------------
// Recording HUD window (countdown, timer, pause, stop)  <->  main

export const HUD = {
  /** main -> hud push */
  state: 'polish:hud:state',
  /** hud -> main (send) */
  stop: 'polish:hud:stop',
  togglePause: 'polish:hud:toggle-pause'
} as const

/** API exposed to the HUD page by src/preload/hud.ts as window.polishHud */
export interface HudBridge {
  onState: (handler: (state: RecordingState) => void) => () => void
  stop: () => void
  togglePause: () => void
}

export const GHOST = {
  /** main -> ghost push: pointer position in screen coordinates (fallback path) */
  point: 'polish:ghost:point'
} as const

/** API exposed to the ghost cursor page by src/preload/ghost.ts as window.polishGhost */
export interface GhostBridge {
  onPoint: (handler: (point: { x: number; y: number }) => void) => () => void
}
