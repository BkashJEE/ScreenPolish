import type { RecordingEvents } from './types'

/**
 * Click timing: line the input log up with the picture.
 *
 * Clicks, the pointer path and scrolls are stamped as they happen, and the
 * picture is stamped by the screen recorder. When the screen shown in the
 * video runs behind the log (an app slow to answer a click, or a capture whose
 * frames reach the encoder late), every click effect lands before the screen
 * reacts. Moving the whole log later by `syncSec` puts the pointer, the click
 * effects and the zooms built from them back onto what the picture shows.
 */

/** The range the editor offers, in seconds. Negative moves the log earlier. */
export const SYNC_MIN_SEC = -0.5
export const SYNC_MAX_SEC = 1.5

export function clampSync(sec: unknown): number {
  const s = Number(sec)
  if (!Number.isFinite(s)) return 0
  return Math.round(Math.min(SYNC_MAX_SEC, Math.max(SYNC_MIN_SEC, s)) * 100) / 100
}

/**
 * `events` with every input timestamp moved by `syncSec`. Pauses are video
 * times, not input times, and stay where they are. The same object comes back
 * when there is nothing to move, so memoised consumers do not recompute.
 */
export function syncEvents(events: RecordingEvents, syncSec: number | undefined): RecordingEvents {
  const ms = Math.round(clampSync(syncSec ?? 0) * 1000)
  if (ms === 0) return events
  return {
    ...events,
    pointer: events.pointer.map(([t, x, y]) => [t + ms, x, y] as [number, number, number]),
    clicks: events.clicks.map((c) => ({ ...c, t: c.t + ms })),
    wheel: events.wheel.map((w) => ({ ...w, t: w.t + ms })),
    keys: events.keys.map((k) => ({ ...k, t: k.t + ms }))
  }
}
