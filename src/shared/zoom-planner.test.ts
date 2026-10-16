import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT, type MouseButton, type Project, type RecordingEvents, type ZoomSegment } from './types'
import { DEFAULT_ZOOM_PLAN, baseSegmentId, planAutoZoom, resolveZoomSegments, autoStyle } from './zoom-planner'
import { cameraAt } from './camera'
import { HOLD_GAP_SEC } from './camera'

const region = { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }

function click(t: number, x: number, y: number, down = true, button: MouseButton = 'left') {
  return { t, x, y, button, down }
}

function makeEvents(partial: Partial<RecordingEvents> = {}): RecordingEvents {
  return { version: 1, startedAt: 0, region, pointer: [], clicks: [], wheel: [], keys: [], ...partial }
}

function project(zoom: Partial<Project['zoom']>): Project {
  return { ...DEFAULT_PROJECT, zoom: { ...DEFAULT_PROJECT.zoom, ...zoom } }
}

function expectSortedNonOverlapping(segments: ZoomSegment[], duration: number) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    expect(s.end).toBeGreaterThan(s.start)
    expect(s.start).toBeGreaterThanOrEqual(0)
    expect(s.end).toBeLessThanOrEqual(duration)
    if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segments[i - 1].end)
  }
}

/** Pure clustering: no merge, no extension, tiny lead-in/out. */
const CLUSTER_ONLY = { leadInSec: 0.1, leadOutSec: 0.1, mergeGapSec: 0, minSegmentSec: 0 }

describe('smart clicks', () => {
  it('holds repeated nearby clicks as one steady zoom', () => {
    const segments = planAutoZoom(makeEvents({ clicks: [click(2000, 500, 500), click(2300, 510, 510)] }), 10, { motion: 'smart' })
    expect(segments).toHaveLength(1)
    expect(segments[0].style).toBe('zoom')
  })
  it('keeps distant clicks separate and pans continuously without returning wide', () => {
    const segments = planAutoZoom(makeEvents({ clicks: [click(2000, 500, 500), click(3000, 1400, 500)] }), 10, { motion: 'smart' })
    expect(segments).toHaveLength(2)
    expect(segments.map(s => s.x)).toEqual([500, 1400])
    expectSortedNonOverlapping(segments, 10)
    const boundary = segments[1].start
    const before = cameraAt(boundary - 0.00001, segments, null, region)
    const after = cameraAt(boundary, segments, null, region)
    expect(before.cx).toBeCloseTo(after.cx, 3)
    expect(after.scale).toBeCloseTo(2, 1)
  })
  it('returns wide during a pause and does not invent clicks', () => {
    const segments = planAutoZoom(makeEvents({ clicks: [click(2000, 500, 500), click(8000, 1400, 500)] }), 12, { motion: 'smart' })
    expect(cameraAt(5, segments, null, region).scale).toBe(1)
    expect(planAutoZoom(makeEvents(), 12, { motion: 'smart' })).toEqual([])
  })
})

describe('planAutoZoom', () => {
  it('returns nothing without clicks', () => {
    expect(planAutoZoom(makeEvents(), 20)).toEqual([])
  })

  it('ignores mouseup events', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 100, false)] })
    expect(planAutoZoom(events, 20)).toEqual([])
  })

  it('ignores clicks outside the captured region', () => {
    const events = makeEvents({
      clicks: [click(5000, -1, 100), click(6000, 100, -1), click(7000, 1920, 100), click(8000, 100, 1080)]
    })
    expect(planAutoZoom(events, 20)).toEqual([])
  })

  it('returns nothing for a non-positive duration', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 100)] })
    expect(planAutoZoom(events, 0)).toEqual([])
    expect(planAutoZoom(events, -3)).toEqual([])
  })

  it('makes one segment from a single click with lead-in/out and the default scale', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 200)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(1)
    const s = segs[0]
    expect(s.id).toBe('auto-0')
    expect(s.source).toBe('auto')
    expect(s.scale).toBe(DEFAULT_ZOOM_PLAN.scale)
    expect(s.start).toBeCloseTo(5 - DEFAULT_ZOOM_PLAN.leadInSec)
    expect(s.end).toBeCloseTo(5 + DEFAULT_ZOOM_PLAN.leadOutSec)
    expect(s.x).toBe(100)
    expect(s.y).toBe(200)
  })

  it('applies cfg.scale', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 200)] })
    expect(planAutoZoom(events, 20, { scale: 3.5 })[0].scale).toBe(3.5)
  })

  it('clamps segments to [0, duration]', () => {
    const early = planAutoZoom(makeEvents({ clicks: [click(200, 0, 0)] }), 20)
    expect(early[0].start).toBe(0)
    expect(early[0].end).toBeCloseTo(1.6)
    const late = planAutoZoom(makeEvents({ clicks: [click(19500, 0, 0)] }), 20, { minSegmentSec: 0 })
    expect(late[0].end).toBe(20)
    expect(late[0].start).toBeCloseTo(19)
  })

  it('drops clicks that fall after the duration', () => {
    expect(planAutoZoom(makeEvents({ clicks: [click(25000, 0, 0)] }), 20)).toEqual([])
  })

  it('clusters clicks within clusterGapSec at the same spot', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 100), click(6500, 140, 100)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBeCloseTo(7.9)
    expect(segs[0].x).toBeCloseTo(120)
    expect(segs[0].y).toBeCloseTo(100)
  })

  it('separates clicks further apart than clusterGapSec in time', () => {
    const events = makeEvents({ clicks: [click(5000, 100, 100), click(8000, 100, 100)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(2)
    expect(segs[0].id).toBe('auto-0')
    expect(segs[1].id).toBe('auto-1')
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBeCloseTo(6.4)
    expect(segs[1].start).toBeCloseTo(7.5)
    expect(segs[1].end).toBeCloseTo(9.4)
  })

  it('separates clicks further apart than clusterDistPx in space', () => {
    const far = makeEvents({ clicks: [click(5000, 0, 0), click(5500, 1000, 0)] })
    expect(planAutoZoom(far, 20, CLUSTER_ONLY)).toHaveLength(2)
    const near = makeEvents({ clicks: [click(5000, 0, 0), click(5500, 300, 0)] })
    expect(planAutoZoom(near, 20, CLUSTER_ONLY)).toHaveLength(1)
    // Euclidean: 300,300 is ~424 px away.
    const diagonal = makeEvents({ clicks: [click(5000, 0, 0), click(5500, 300, 300)] })
    expect(planAutoZoom(diagonal, 20, CLUSTER_ONLY)).toHaveLength(2)
  })

  it('chains clusters click-to-click, not first-to-last', () => {
    const events = makeEvents({ clicks: [click(5000, 0, 0), click(6500, 0, 0), click(8000, 0, 0)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBeCloseTo(9.4)
  })

  it('merges segments whose gap is below mergeGapSec', () => {
    // 2.5 s apart: separate clusters, spans [4.5,6.4] and [7.0,8.9], gap 0.6 < 0.8.
    const events = makeEvents({ clicks: [click(5000, 0, 0), click(7500, 0, 0)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBeCloseTo(8.9)
  })

  it('uses a click-weighted centroid when merging', () => {
    const events = makeEvents({
      clicks: [click(5000, 0, 0), click(5200, 400, 0), click(5400, 400, 0), click(5600, 400, 0)]
    })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(1)
    expect(segs[0].x).toBeCloseTo(300)
    expect(segs[0].y).toBeCloseTo(0)
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBeCloseTo(7.0)
  })

  it('extends segments shorter than minSegmentSec forward', () => {
    const events = makeEvents({ clicks: [click(5000, 0, 0)] })
    const segs = planAutoZoom(events, 20, { leadInSec: 0.1, leadOutSec: 0.1 })
    expect(segs[0].start).toBeCloseTo(4.9)
    expect(segs[0].end).toBeCloseTo(4.9 + DEFAULT_ZOOM_PLAN.minSegmentSec)
  })

  it('extends backward when the end hits the duration', () => {
    const events = makeEvents({ clicks: [click(19950, 0, 0)] })
    const segs = planAutoZoom(events, 20, { leadInSec: 0.1, leadOutSec: 0.1 })
    expect(segs[0].end).toBe(20)
    expect(segs[0].start).toBeCloseTo(20 - DEFAULT_ZOOM_PLAN.minSegmentSec)
  })

  it('re-merges segments that extension pushed together', () => {
    // Spans [4.9,5.1] and [6.1,6.3]: gap 1.0 >= 0.8. Extending both to 1.2 s gives [4.9,6.1] and [6.1,7.3].
    const events = makeEvents({ clicks: [click(5000, 0, 0), click(6200, 0, 0)] })
    const segs = planAutoZoom(events, 20, { leadInSec: 0.1, leadOutSec: 0.1, clusterGapSec: 0.5 })
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBeCloseTo(4.9)
    expect(segs[0].end).toBeCloseTo(7.3)
  })

  it('accepts unsorted click logs', () => {
    const events = makeEvents({ clicks: [click(8000, 0, 0), click(5000, 100, 100)] })
    const segs = planAutoZoom(events, 20)
    expect(segs).toHaveLength(2)
    expect(segs[0].x).toBe(100)
    expect(segs[1].x).toBe(0)
  })

  it('produces sorted, non-overlapping, sufficiently long segments with stable ids for a busy log', () => {
    const clicks: RecordingEvents['clicks'] = []
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 60; i++) clicks.push(click(rnd() * 60000, rnd() * 1920, rnd() * 1080))
    const events = makeEvents({ clicks })
    const segs = planAutoZoom(events, 60)
    expect(segs.length).toBeGreaterThan(1)
    expectSortedNonOverlapping(segs, 60)
    segs.forEach((s, i) => {
      expect(s.id).toBe(`auto-${i}`)
      expect(s.end - s.start).toBeGreaterThanOrEqual(DEFAULT_ZOOM_PLAN.minSegmentSec - 1e-9)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeGreaterThanOrEqual(0)
    })
    expect(planAutoZoom(events, 60)).toEqual(segs)
  })
})

describe('resolveZoomSegments', () => {
  const events = makeEvents({ clicks: [click(5000, 800, 500), click(12000, 1200, 700)] })
  const duration = 20

  it('returns nothing when zoom is disabled', () => {
    expect(resolveZoomSegments(project({ enabled: false }), events, duration)).toEqual([])
  })

  it('returns nothing when auto is off and there are no manual segments', () => {
    expect(resolveZoomSegments(project({ auto: false }), events, duration)).toEqual([])
  })

  it('plans auto segments with the project scale', () => {
    const segs = resolveZoomSegments(project({ scale: 3 }), events, duration)
    expect(segs).toHaveLength(2)
    expect(segs.every((s) => s.scale === 3 && s.source === 'auto')).toBe(true)
    expect(segs.map((s) => s.id)).toEqual(['auto-0', 'auto-1'])
  })

  it('drops auto segments listed in removedAuto', () => {
    const segs = resolveZoomSegments(project({ removedAuto: ['auto-0'] }), events, duration)
    expect(segs.map((s) => s.id)).toEqual(['auto-1'])
  })

  it('matches removedAuto by base id so a split piece removes the whole auto segment', () => {
    const segs = resolveZoomSegments(project({ removedAuto: ['auto-1~2'] }), events, duration)
    expect(segs.map((s) => s.id)).toEqual(['auto-0'])
  })

  it('keeps removedAuto ids stable when a manual segment is added', () => {
    const manual: ZoomSegment = { id: 'm1', start: 1, end: 2, x: 0, y: 0, scale: 2, source: 'manual' }
    const segs = resolveZoomSegments(project({ removedAuto: ['auto-0'], manual: [manual] }), events, duration)
    expect(segs.map((s) => s.id)).toEqual(['m1', 'auto-1'])
  })

  it('splits an auto segment around a manual one', () => {
    const manual: ZoomSegment = { id: 'm1', start: 5, end: 5.5, x: 10, y: 10, scale: 3, source: 'manual' }
    const segs = resolveZoomSegments(project({ manual: [manual] }), events, duration)
    expect(segs.map((s) => [s.id, s.source])).toEqual([
      ['auto-0', 'auto'],
      ['m1', 'manual'],
      ['auto-0~2', 'auto'],
      ['auto-1', 'auto']
    ])
    expect(segs[0].start).toBeCloseTo(4.5)
    expect(segs[0].end).toBe(5)
    expect(segs[1]).toMatchObject({ start: 5, end: 5.5, x: 10, y: 10, scale: 3 })
    expect(segs[2].start).toBe(5.5)
    expect(segs[2].end).toBeCloseTo(6.4)
    expect(segs[2].x).toBe(800)
    expect(baseSegmentId(segs[2].id)).toBe('auto-0')
    expectSortedNonOverlapping(segs, duration)
  })

  it('clips the start of an auto segment under a manual one', () => {
    const manual: ZoomSegment = { id: 'm1', start: 4, end: 5, x: 0, y: 0, scale: 2, source: 'manual' }
    const segs = resolveZoomSegments(project({ manual: [manual] }), events, duration)
    expect(segs[0].id).toBe('m1')
    expect(segs[1].id).toBe('auto-0')
    expect(segs[1].start).toBe(5)
    expect(segs[1].end).toBeCloseTo(6.4)
    expectSortedNonOverlapping(segs, duration)
  })

  it('drops an auto segment fully covered by a manual one', () => {
    const manual: ZoomSegment = { id: 'm1', start: 4, end: 7, x: 0, y: 0, scale: 2, source: 'manual' }
    const segs = resolveZoomSegments(project({ manual: [manual] }), events, duration)
    expect(segs.map((s) => s.id)).toEqual(['m1', 'auto-1'])
  })

  it('lets later manual segments win over earlier ones', () => {
    const m1: ZoomSegment = { id: 'm1', start: 2, end: 6, x: 0, y: 0, scale: 2, source: 'manual' }
    const m2: ZoomSegment = { id: 'm2', start: 3, end: 4, x: 5, y: 5, scale: 4, source: 'manual' }
    const segs = resolveZoomSegments(project({ auto: false, manual: [m1, m2] }), events, duration)
    expect(segs.map((s) => [s.id, s.start, s.end, s.scale])).toEqual([
      ['m1', 2, 3, 2],
      ['m2', 3, 4, 4],
      ['m1~2', 4, 6, 2]
    ])
    expectSortedNonOverlapping(segs, duration)
  })

  it('clamps manual segments to the duration and skips empty ones', () => {
    const late: ZoomSegment = { id: 'late', start: 18, end: 30, x: 0, y: 0, scale: 2, source: 'manual' }
    const empty: ZoomSegment = { id: 'empty', start: 9, end: 9, x: 0, y: 0, scale: 2, source: 'manual' }
    const beyond: ZoomSegment = { id: 'beyond', start: 25, end: 30, x: 0, y: 0, scale: 2, source: 'manual' }
    const segs = resolveZoomSegments(project({ auto: false, manual: [late, empty, beyond] }), events, duration)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ id: 'late', start: 18, end: 20 })
  })

  it('forces source to manual on manual entries', () => {
    const m: ZoomSegment = { id: 'm', start: 1, end: 2, x: 0, y: 0, scale: 2, source: 'auto' }
    const segs = resolveZoomSegments(project({ auto: false, manual: [m] }), events, duration)
    expect(segs[0].source).toBe('manual')
  })

  it('never emits duplicate ids', () => {
    const cuts: ZoomSegment[] = [5, 5.4, 5.8].map((t, i) => ({
      id: `c${i}`,
      start: t,
      end: t + 0.2,
      x: 0,
      y: 0,
      scale: 2,
      source: 'manual'
    }))
    const segs = resolveZoomSegments(project({ manual: cuts }), events, duration)
    const ids = segs.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('auto-0~2')
    expect(ids).toContain('auto-0~3')
    expectSortedNonOverlapping(segs, duration)
  })
})


describe('autoStyle', () => {
  it('cycles zoom, tilt toward the click side, drift; zoom-only stays plain', () => {
    expect(autoStyle(0, 100, 1920, 'cinematic')).toBe('zoom')
    expect(autoStyle(1, 100, 1920, 'cinematic')).toBe('tilt-left')
    expect(autoStyle(1, 1800, 1920, 'cinematic')).toBe('tilt-right')
    expect(autoStyle(2, 100, 1920, 'cinematic')).toBe('drift')
    expect(autoStyle(3, 100, 1920, 'cinematic')).toBe('zoom')
    expect(autoStyle(4, 100, 1920, 'cinematic')).toBe('tilt-right')
    expect(autoStyle(5, 100, 1920, 'cinematic')).toBe('orbit')
    expect(autoStyle(1, 100, 1920, 'zoom')).toBe('zoom')
    expect(autoStyle(4, 100, 1920, 'punch')).toBe('punch')
  })
})

describe('clicks too far apart to share a view', () => {
  // Two clicks 2.3 s apart at opposite corners: close enough in time to merge, too far apart to show both at 2x.
  const events = makeEvents({ clicks: [click(49_680, 300, 300), click(51_990, 1700, 950)] })

  it('keep their own zooms, close enough that the camera pans from one to the other', () => {
    const segs = planAutoZoom(events, 60)
    expect(segs).toHaveLength(2)
    expect(segs[1]!.start - segs[0]!.end).toBeLessThan(HOLD_GAP_SEC)
    expect([segs[0]!.x, segs[1]!.x]).toEqual([300, 1700])
    for (const s of segs) expect(s.end - s.start).toBeGreaterThanOrEqual(DEFAULT_ZOOM_PLAN.minSegmentSec - 1e-9)
  })

  it('still merge when both fit in one view', () => {
    const near = makeEvents({ clicks: [click(49_680, 800, 500), click(51_990, 1000, 600)] })
    expect(planAutoZoom(near, 60)).toHaveLength(1)
  })

  it('merge as before when they come too fast to give each a readable zoom', () => {
    const rapid = makeEvents({ clicks: [click(10_000, 200, 200), click(10_300, 1700, 900)] })
    expect(planAutoZoom(rapid, 60)).toHaveLength(1)
  })

  it('merge as before in a project that removed automatic zooms, so its removals keep their meaning', () => {
    expect(planAutoZoom(events, 60, { keepApart: false })).toHaveLength(1)
    const removedOne = resolveZoomSegments(project({ removedAuto: ['auto-0'] }), events, 60)
    expect(removedOne).toHaveLength(0)
    expect(resolveZoomSegments(project({ removedAuto: [] }), events, 60)).toHaveLength(2)
  })
})
