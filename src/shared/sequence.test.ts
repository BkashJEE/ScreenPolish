import { describe, expect, it } from 'vitest'
import {
  MAX_SEQUENCE_TRANSITION_SEC,
  MIN_SEQUENCE_CLIP_SEC,
  clipAtSequenceTime,
  clipRange,
  createSequence,
  moveClip,
  normalizeSequence,
  placeClips,
  removeSequenceClip,
  rippleAfter,
  sequenceDuration,
  sequenceTakes,
  setClipTransition,
  type Sequence
} from './sequence'

const cut = { style: 'none' as const, durationSec: 0.5 }
const fade = (d: number) => ({ style: 'dissolve' as const, durationSec: d })
function seq(...clips: Array<Partial<Sequence['clips'][number]>>): Sequence {
  return normalizeSequence({ version: 1, title: 't', clips: clips.map((c, i) => ({ id: `c${i}`, kind: 'recording', take: `take-${i}`, in: 0, out: null, ...c })) })
}

describe('normalizeSequence', () => {
  it('keeps good clips and drops ones that could reach outside the recordings folder', () => {
    const s = normalizeSequence({
      title: '  Demo   reel ',
      clips: [
        { id: 'a', take: '2026-10-15_12-37-15', in: 2, out: 9 },
        { id: 'b', take: '../etc' },
        { id: 'c', take: 'x/y' },
        { id: 'd', take: '' },
        { id: 'e', kind: 'card', take: 'z' },
        { id: 'a', take: '2026-10-13_10-39-14', in: -3, out: -1, transition: { style: 'blur', durationSec: 9 } }
      ]
    })
    expect(s.title).toBe('Demo reel')
    expect(s.clips.map((c) => c.take)).toEqual(['2026-10-15_12-37-15', '2026-10-13_10-39-14'])
    expect(new Set(s.clips.map((c) => c.id)).size).toBe(2)
    expect(s.clips[1]).toMatchObject({ in: 0, out: null, transition: { style: 'dissolve', durationSec: MAX_SEQUENCE_TRANSITION_SEC } })
  })

  it('reads garbage as an empty sequence', () => {
    expect(normalizeSequence(null)).toEqual({ version: 1, title: '', clips: [] })
    expect(normalizeSequence({ clips: 'nope' }).clips).toEqual([])
  })

  it('survives a round trip through JSON', () => {
    const s = createSequence(['a', 'b'], 'Reel')
    expect(normalizeSequence(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })
})

describe('placing clips', () => {
  it('clamps in and out to the take', () => {
    expect(clipRange({ id: 'x', kind: 'recording', take: 't', in: 3, out: 50 }, 20)).toEqual({ in: 3, out: 20 })
    expect(clipRange({ id: 'x', kind: 'recording', take: 't', in: 30, out: null }, 20)).toEqual({ in: 20, out: 20 })
  })

  it('lines hard cuts up end to end', () => {
    const s = seq({ transition: cut }, { in: 2, out: 6 })
    expect(placeClips(s, [10, 30]).map((p) => [p.start, p.end])).toEqual([[0, 10], [10, 14]])
    expect(sequenceDuration(s, [10, 30])).toBe(14)
  })

  it('overlaps neighbours by the crossfade, never more than half a clip', () => {
    const s = seq({ transition: fade(1) }, { transition: fade(2) }, {})
    const p = placeClips(s, [10, 3, 8])
    expect(p.map((c) => c.overlapNext)).toEqual([1, 1.5, 0])
    expect(p.map((c) => c.start)).toEqual([0, 9, 10.5])
    expect(sequenceDuration(s, [10, 3, 8])).toBe(18.5)
  })

  it('ignores the transition on the last clip', () => {
    expect(sequenceDuration(seq({}, { transition: fade(1) }), [5, 5])).toBe(10)
  })
})

describe('clipAtSequenceTime', () => {
  const s = seq({ transition: cut }, { in: 4, out: 9, transition: fade(1) }, {})
  const lengths = [10, 20, 6]

  it('finds the clip and the time inside its take', () => {
    expect(clipAtSequenceTime(s, lengths, 3)).toEqual({ clipIndex: 0, localTime: 3 })
    expect(clipAtSequenceTime(s, lengths, 10)).toEqual({ clipIndex: 1, localTime: 4 })
    expect(clipAtSequenceTime(s, lengths, 12.5)).toEqual({ clipIndex: 1, localTime: 6.5 })
  })

  it('names both clips during a crossfade, the incoming one first', () => {
    const p = clipAtSequenceTime(s, lengths, 14.5)!
    expect(p.clipIndex).toBe(2)
    expect(p.localTime).toBeCloseTo(0.5)
    expect(p.fadingOut).toMatchObject({ clipIndex: 1, progress: 0.5 })
    expect(p.fadingOut!.localTime).toBeCloseTo(8.5)
  })

  it('clamps outside the sequence, and is null for an empty one', () => {
    expect(clipAtSequenceTime(s, lengths, -5)).toEqual({ clipIndex: 0, localTime: 0 })
    expect(clipAtSequenceTime(s, lengths, 999)).toMatchObject({ clipIndex: 2, localTime: 6 })
    expect(clipAtSequenceTime(seq(), [], 1)).toBeNull()
  })
})

describe('rippleAfter', () => {
  const s = seq({ transition: cut }, {})
  const lengths = [10, 5]

  it('shortens a clip and moves the rest up', () => {
    const r = rippleAfter(s, lengths, 0, -3)
    expect(r.shift).toBe(-3)
    expect(r.sequence.clips[0]!.out).toBe(7)
    expect(placeClips(r.sequence, lengths)[1]!.start).toBe(7)
  })

  it('never goes past the take or below the shortest clip', () => {
    expect(rippleAfter(s, lengths, 0, 5)).toEqual({ sequence: s, shift: 0 })
    const r = rippleAfter(s, lengths, 0, -50)
    expect(r.sequence.clips[0]!.out).toBe(MIN_SEQUENCE_CLIP_SEC)
    // Lengthening back to the end of the take goes back to "to the end".
    expect(rippleAfter(r.sequence, lengths, 0, 50).sequence.clips[0]!.out).toBeNull()
  })
})

describe('editing', () => {
  const s = seq({}, {}, {})
  it('moves, removes and sets transitions', () => {
    expect(moveClip(s, 0, 2).clips.map((c) => c.take)).toEqual(['take-1', 'take-2', 'take-0'])
    expect(moveClip(s, 2, 0).clips.map((c) => c.take)).toEqual(['take-2', 'take-0', 'take-1'])
    expect(removeSequenceClip(s, 1).clips.map((c) => c.take)).toEqual(['take-0', 'take-2'])
    expect(setClipTransition(s, 0, fade(0.8)).clips[0]!.transition).toEqual(fade(0.8))
  })

  it('lists each take once', () => {
    expect(sequenceTakes(seq({ take: 'a' }, { take: 'b' }, { take: 'a' }))).toEqual(['a', 'b'])
  })

  it('starts new sequences with every take whole and crossfaded', () => {
    const n = createSequence(['a', 'b'])
    expect(n.clips.map((c) => [c.take, c.in, c.out, c.transition?.style])).toEqual([['a', 0, null, 'dissolve'], ['b', 0, null, 'dissolve']])
  })
})
