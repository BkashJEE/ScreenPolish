import { describe, expect, it } from 'vitest'
import type { RecordingEvents } from './types'
import { SYNC_MAX_SEC, SYNC_MIN_SEC, clampSync, syncEvents } from './input-sync'

const events: RecordingEvents = {
  version: 1,
  startedAt: 1000,
  region: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
  pointer: [[0, 1, 2], [500, 3, 4]],
  clicks: [{ t: 400, x: 3, y: 4, button: 'left', down: true }],
  wheel: [{ t: 450, x: 3, y: 4, dy: 1 }],
  keys: [{ t: 420, key: 'a', down: true }],
  pauses: [{ t: 2, durationSec: 3 }]
}

describe('syncEvents', () => {
  it('moves every input time later, and leaves pauses and positions alone', () => {
    const s = syncEvents(events, 0.75)
    expect(s.pointer).toEqual([[750, 1, 2], [1250, 3, 4]])
    expect(s.clicks[0]).toMatchObject({ t: 1150, x: 3, y: 4, down: true })
    expect(s.wheel[0]!.t).toBe(1200)
    expect(s.keys[0]!.t).toBe(1170)
    expect(s.pauses).toEqual(events.pauses)
    expect(events.clicks[0]!.t).toBe(400) // the original is untouched
  })

  it('moves earlier for a negative timing', () => {
    expect(syncEvents(events, -0.2).clicks[0]!.t).toBe(200)
  })

  it('returns the same object when there is nothing to move', () => {
    expect(syncEvents(events, 0)).toBe(events)
    expect(syncEvents(events, undefined)).toBe(events)
  })
})

describe('clampSync', () => {
  it('keeps the timing to the offered range, in hundredths', () => {
    expect(clampSync(0.333)).toBe(0.33)
    expect(clampSync(9)).toBe(SYNC_MAX_SEC)
    expect(clampSync(-9)).toBe(SYNC_MIN_SEC)
    for (const bad of [NaN, 'soon', undefined, null]) expect(clampSync(bad)).toBe(0)
  })
})
