import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import type { RecordingEvents } from '@shared/types'

/**
 * Typing, found in the picture.
 *
 * ScreenPolish never opens the keyboard on Linux, so typing is recognised the
 * way a viewer would: the pointer rests, nothing is clicked, and small parts
 * of the screen keep changing several times a second as letters appear. A
 * blinking text cursor also changes a few pixels, but only about twice a
 * second; scrolling and page loads change large parts at once. Both are told
 * apart from typing by those numbers.
 */

/** Frames per second the picture is sampled at, and the width it is shrunk to. */
export const TYPING_FPS = 10
export const TYPING_WIDTH = 320
/** A pixel counts as changed when its brightness moves by this much (0-255). */
export const CHANGE_LEVEL = 24
/** Changed pixels a sampled frame needs to count: a letter, not noise. */
export const MIN_CHANGED_PX = 5
/** More than this share of the frame changing is scrolling or a new page, not typing. */
export const MAX_CHANGED_SHARE = 0.02
/** Frames with a small change needed in any one second: a blinking caret gives two. */
export const MIN_ACTIVE_PER_SEC = 4
/** The pointer may drift this far (video pixels) and still be resting. */
export const STILL_PX = 8
/** Shorter stretches are not worth speeding up; gaps up to this long join two. */
export const MIN_TYPING_SEC = 1.5
export const JOIN_GAP_SEC = 0.6

export interface TypingRange {
  start: number
  end: number
}

/** Changed-pixel count between consecutive grey frames, one entry per frame (the first is 0). */
export function frameChanges(frames: readonly Uint8Array[]): number[] {
  return frames.map((f, i) => {
    if (i === 0) return 0
    const prev = frames[i - 1]!
    let n = 0
    for (let p = 0; p < f.length; p++) if (Math.abs(f[p]! - prev[p]!) >= CHANGE_LEVEL) n++
    return n
  })
}

/** Whether the pointer rested, unclicked, around `t` seconds. */
function resting(events: Pick<RecordingEvents, 'pointer' | 'clicks'>, t: number): boolean {
  const ms = t * 1000
  if (events.clicks.some((c) => c.down && Math.abs(c.t - ms) <= 400)) return false
  const near = events.pointer.filter((p) => Math.abs(p[0] - ms) <= 300)
  if (near.length < 2) return true
  const xs = near.map((p) => p[1])
  const ys = near.map((p) => p[2])
  return Math.max(...xs) - Math.min(...xs) <= STILL_PX && Math.max(...ys) - Math.min(...ys) <= STILL_PX
}

/**
 * Typing stretches from per-frame change counts sampled at `fps`, with
 * `framePixels` pixels in each frame, and the input log for the pointer.
 */
export function typingRanges(changes: readonly number[], fps: number, framePixels: number, events: Pick<RecordingEvents, 'pointer' | 'clicks'>): TypingRange[] {
  const small = changes.map((n) => n >= MIN_CHANGED_PX && n <= MAX_CHANGED_SHARE * framePixels)
  const busy = changes.map((n) => n > MAX_CHANGED_SHARE * framePixels)
  const typing: boolean[] = changes.map((_, i) => {
    // Counted over the second around this frame; anything large in it rules the frame out.
    const lo = Math.max(0, i - Math.floor(fps / 2))
    const hi = Math.min(changes.length, lo + fps)
    let active = 0
    for (let j = lo; j < hi; j++) {
      if (busy[j]) return false
      if (small[j]) active++
    }
    return active >= MIN_ACTIVE_PER_SEC && resting(events, i / fps)
  })
  const ranges: TypingRange[] = []
  typing.forEach((on, i) => {
    if (!on) return
    const t = i / fps
    const last = ranges.at(-1)
    if (last && t - last.end <= JOIN_GAP_SEC) last.end = t + 1 / fps
    else ranges.push({ start: t, end: t + 1 / fps })
  })
  return ranges.filter((r) => r.end - r.start >= MIN_TYPING_SEC).map((r) => ({ start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 }))
}

function videoSize(ffmpeg: string, video: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-i', video], (_e, _out, stderr) => {
      const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(String(stderr))
      if (m) resolve({ width: Number(m[1]), height: Number(m[2]) })
      else reject(new Error('Could not read the recording to look for typing.'))
    })
  })
}

/** Typing stretches in `video`, in seconds of the recording. Frames are streamed, never all held at once. */
export async function findTyping(ffmpeg: string, video: string, events: Pick<RecordingEvents, 'pointer' | 'clicks'>): Promise<TypingRange[]> {
  const size = await videoSize(ffmpeg, video)
  const w = Math.min(TYPING_WIDTH, size.width)
  const h = Math.max(2, Math.round((size.height * w) / size.width / 2) * 2)
  const frameBytes = w * h
  const changes: number[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', video, '-vf', `fps=${TYPING_FPS},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = Buffer.alloc(0)
    let prev: Uint8Array | null = null
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= frameBytes) {
        const frame = new Uint8Array(pending.subarray(0, frameBytes))
        pending = pending.subarray(frameBytes)
        changes.push(prev ? frameChanges([prev, frame])[1]! : 0)
        prev = frame
      }
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not read the recording: ${err.trim().split('\n').at(-1) ?? code}`))))
  })
  return typingRanges(changes, TYPING_FPS, frameBytes, events)
}
