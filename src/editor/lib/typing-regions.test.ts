import { describe, expect, it } from 'vitest'
import { TYPING_RATE, typingRegions } from './typing-regions'

describe('typingRegions', () => {
  it('adds a region per stretch, eased, skipping overlaps and slivers', () => {
    const out = typingRegions([{ start: 2, end: 6 }, { start: 8, end: 8.9 }, { start: 10, end: 14 }, { start: 13, end: 16 }], [{ start: 11, end: 12 }])
    // 8-8.9 is too short and 10-14 overlaps the region already there; 13-16 only met that skipped one.
    expect(out.map((r) => [r.start, r.end])).toEqual([[2.1, 5.9], [13.1, 15.9]])
    expect(out[0]).toMatchObject({ rate: TYPING_RATE, ease: 0.2 })
  })
})
