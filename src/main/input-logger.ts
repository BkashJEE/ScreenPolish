// Global input hook → RecordingEvents. Timestamps are Date.now() - startedAt
// minus time spent paused, so they line up with the video, which also drops
// paused time.
//
// Platform sources funnel into the same record* methods, so events.json has one
// shape whatever produced it:
//   Linux   — the compositor's pointer position plus evdev buttons (./linux/input-source.ts)
//   Windows and macOS — the global uiohook hook (./win/uiohook-source.ts)
// This file holds only the shared part: timing, thinning and coordinate mapping.

import type { CaptureRegion, MouseButton, RecordingEvents } from '@shared/types'
import { POINTER_MIN_GAP_MS, createPointerThinner, toRegionRelative } from './input-math'
import { LinuxInputSource, type InputCapabilities } from './linux/input-source'
import { snapshotWindows, windowRelativePoint, type HyprClient, type HyprMonitor } from './linux/capture-target'
import { UiohookSource, preloadInputHook as preloadUiohook } from './win/uiohook-source'

export { thinPointer, toRegionRelative } from './input-math'

const IS_LINUX = process.platform === 'linux'

/**
 * Window geometry refresh while recording. Every poll is a socket round trip
 * served on the compositor's main loop, so this stays well below the 60 Hz
 * pointer poll; a window cannot move far enough between frames to matter.
 */
export const WINDOW_POLL_MS = 150

/** Warm the platform's input source at startup so `InputLogger.start` can stay synchronous. */
export async function preloadInputHook(): Promise<void> {
  if (IS_LINUX) return
  await preloadUiohook()
}

export class InputLogger {
  private events: RecordingEvents | null = null
  private startedAt = 0
  private pausedAt: number | null = null
  private pausedTotal = 0
  private keepPointer = createPointerThinner(POINTER_MIN_GAP_MS)
  private pointScale = 1
  private pauses: Array<{ t: number; durationSec: number }> = []
  private pauseVideoT = 0
  private linux: LinuxInputSource | null = null
  private uiohook: UiohookSource | null = null
  private caps: InputCapabilities | null = null
  private windowTimer: NodeJS.Timeout | null = null
  private trackedWindow: HyprClient | null = null
  private trackedMonitors: HyprMonitor[] = []
  private windowAddress: string | undefined

  /** Told of every press inside the recording, with its time on the recording clock (the recording guide moves on). */
  onPress: ((tMs: number) => void) | null = null

  get running(): boolean {
    return this.events !== null
  }

  /** Mark that a guided step began now; returns its time on the recording clock, or null while paused or stopped. */
  markStep(): number | null {
    const ev = this.events
    const t = this.now()
    if (!ev || t === null) return null
    ev.steps = [...(ev.steps ?? []), t]
    return t
  }

  /** Take back the last step mark (the guide's Back button). */
  unmarkStep(): void {
    if (this.events?.steps?.length) this.events.steps = this.events.steps.slice(0, -1)
  }

  /** Time on the recording clock now, or null while paused or stopped. */
  get clockMs(): number | null {
    return this.events ? this.now() : null
  }

  /** Records why the log is short, so the editor can explain an empty take rather than guess. */
  note(reason: string): void {
    if (this.events) this.events.inputNote = reason
  }

  /** What the platform's input source actually delivered, or null off Linux where uiohook gives everything. */
  get capabilities(): InputCapabilities | null {
    return this.caps
  }

  /**
   * `input: false` records an empty input log: used when positions could not be
   * tied to what the video shows, where a wrong log is worse than none.
   */
  start(region: CaptureRegion, startedAt: number, options: { cursorBaked?: boolean; cursorMode?: RecordingEvents['cursorMode']; input?: boolean; inputNote?: string; windowAddress?: string; window?: HyprClient | null; monitors?: readonly HyprMonitor[] } = {}): void {
    if (this.events) this.stop()
    this.events = { version: 1, startedAt, region, pointer: [], clicks: [], wheel: [], keys: [], ...(options.cursorBaked ? { cursorBaked: true } : {}), ...(options.cursorMode ? { cursorMode: options.cursorMode } : {}) }
    // uiohook reports points on macOS and physical px on Windows; the region is
    // physical px. Wayland compositors report logical points like macOS does.
    this.pointScale = process.platform === 'darwin' || IS_LINUX ? region.scale || 1 : 1
    this.startedAt = startedAt
    this.pausedAt = null
    this.pausedTotal = 0
    this.pauses = []
    this.caps = null
    this.keepPointer = createPointerThinner(POINTER_MIN_GAP_MS)
    if (options.input === false) {
      this.note(options.inputNote ?? 'The pointer and clicks were not recorded for this take.')
      return
    }
    if (IS_LINUX) {
      this.windowAddress = options.windowAddress
      this.trackedWindow = options.window ?? null
      this.trackedMonitors = options.monitors ? [...options.monitors] : []
      if (this.windowAddress) {
        let busy = false
        const address = this.windowAddress
        const sessionEvents = this.events
        const refresh = async () => {
          // One poll at a time, and none while paused: the window cannot move
          // into a recording that is not running.
          if (busy || this.pausedAt !== null) return
          busy = true
          try {
            const snapshot = await snapshotWindows()
            if (this.events !== sessionEvents || this.windowAddress !== address) return
            // A failed round trip keeps the last known geometry; only a good
            // snapshot without the window means it is really gone.
            if (!snapshot) return
            this.trackedMonitors = snapshot.monitors
            this.trackedWindow = snapshot.clients.find(c => c.address === address) ?? null
          } finally { busy = false }
        }
        void refresh()
        this.windowTimer = setInterval(() => void refresh(), WINDOW_POLL_MS)
      }
      this.linux = new LinuxInputSource()
      this.caps = this.linux.start({
        onMove: (x, y) => this.recordMove(x, y),
        onButton: (x, y, button, down) => this.recordClick(x, y, button, down),
        onWheel: (x, y, dy) => this.recordWheel(x, y, dy)
      })
      if (this.caps.reason) console.warn(`[input] degraded input log: ${this.caps.reason}`)
      return
    }
    this.uiohook = new UiohookSource()
    this.uiohook.start({
      onMove: (x, y) => this.recordMove(x, y),
      onButton: (x, y, button, down) => this.recordClick(x, y, button, down),
      onWheel: (x, y, dy) => this.recordWheel(x, y, dy),
      onKey: (key, down) => this.recordKey(key, down)
    })
  }

  pause(): void {
    if (this.events && this.pausedAt === null) {
      this.pausedAt = Date.now()
      this.pauseVideoT = (this.pausedAt - this.startedAt - this.pausedTotal) / 1000
    }
  }

  resume(): void {
    if (this.pausedAt !== null) {
      const gap = Date.now() - this.pausedAt
      this.pausedTotal += gap
      this.pausedAt = null
      this.pauses.push({ t: this.pauseVideoT, durationSec: gap / 1000 })
    }
  }

  /** Detaches the hook and returns the log. Safe to call when not running. */
  stop(): RecordingEvents {
    if (this.windowTimer) clearInterval(this.windowTimer)
    this.windowTimer = null
    this.windowAddress = undefined
    this.trackedWindow = null
    this.trackedMonitors = []
    if (this.linux) {
      this.linux.stop()
      this.linux = null
    }
    if (this.uiohook) {
      this.uiohook.stop()
      this.uiohook = null
    }
    const events = this.events ?? {
      version: 1,
      startedAt: this.startedAt,
      region: { x: 0, y: 0, width: 0, height: 0, scale: 1 },
      pointer: [],
      clicks: [],
      wheel: [],
      keys: []
    }
    if (this.pauses.length) events.pauses = [...this.pauses]
    this.pauses = []
    this.events = null
    this.pausedAt = null
    return events
  }

  /** ms since startedAt excluding paused time, or null while paused. */
  private now(): number | null {
    if (this.pausedAt !== null) return null
    return Date.now() - this.startedAt - this.pausedTotal
  }

  /**
   * The three record* methods are the only writers of the event log. They take
   * screen coordinates in whatever units the platform's source reports, apply
   * pointScale, and make them region-relative. Everything above is an adapter.
   */
  private recordMove(sx: number, sy: number): void {
    const ev = this.events
    const t = this.now()
    if (!ev || t === null || !this.keepPointer(t)) return
    const point = this.mapPoint(sx, sy, ev.region)
    if (!point) return
    const [x, y] = point
    ev.pointer.push([t, x, y])
  }

  private recordClick(sx: number, sy: number, button: MouseButton, down: boolean): void {
    const ev = this.events
    const t = this.now()
    if (!ev || t === null) return
    const point = this.mapPoint(sx, sy, ev.region)
    if (!point) return
    const [x, y] = point
    ev.clicks.push({ t, x, y, button, down })
    if (down) this.onPress?.(t)
  }

  private recordWheel(sx: number, sy: number, dy: number): void {
    const ev = this.events
    const t = this.now()
    if (!ev || t === null || dy === 0) return
    const point = this.mapPoint(sx, sy, ev.region)
    if (!point) return
    const [x, y] = point
    ev.wheel.push({ t, x, y, dy })
  }

  private recordKey(key: string, down: boolean): void {
    const ev = this.events
    const t = this.now()
    if (!ev || t === null) return
    ev.keys.push({ t, key, down })
  }

  private mapPoint(x: number, y: number, region: CaptureRegion): [number, number] | null {
    if (this.windowAddress) return this.trackedWindow ? windowRelativePoint(x, y, region, this.trackedWindow, this.trackedMonitors) : null
    return toRegionRelative(x * this.pointScale, y * this.pointScale, region)
  }
}
