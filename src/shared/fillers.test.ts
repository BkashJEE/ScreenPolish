import { describe, expect, it } from 'vitest'
import type { CaptionCue } from './captions'
import { FILLER_CUT_PREFIX, FILLER_PAD_SEC, fillerSummary, findFillers, isFiller } from './fillers'
import { removeSilences, restoreSilences } from './silence'

const cue: CaptionCue = {
  id: 'a', start: 0, end: 4, text: 'So um I think uh, uh we export',
  words: [
    { text: 'So', start: 0, end: 0.3 }, { text: 'um', start: 0.4, end: 0.7 }, { text: 'I', start: 0.8, end: 0.9 }, { text: 'think', start: 0.9, end: 1.3 },
    { text: 'uh,', start: 1.5, end: 1.7 }, { text: 'uh', start: 1.72, end: 1.9 }, { text: 'we', start: 2, end: 2.2 }, { text: 'export', start: 2.2, end: 2.8 }
  ]
}

describe('filler words', () => {
  it('recognises the sounds, not real words', () => {
    for (const w of ['um', 'Uh,', 'UMM.', 'hmm', 'erm']) expect(isFiller(w)).toBe(true)
    for (const w of ['so', 'like', 'umbrella', 'I']) expect(isFiller(w)).toBe(false)
  })

  it('finds each filler with a little air and joins neighbours', () => {
    const found = findFillers([cue])
    expect(found).toHaveLength(2)
    expect(found[0]).toEqual({ start: 0.4 - FILLER_PAD_SEC, end: 0.7 + FILLER_PAD_SEC, word: 'um' })
    expect(found[1]!.word).toBe('uh, uh')
    expect(found[1]!.end).toBeCloseTo(1.9 + FILLER_PAD_SEC)
  })

  it('only trusts lines with the transcriber\\u2019s word times', () => {
    const { words: _w, ...estimated } = cue
    expect(findFillers([estimated])).toEqual([])
  })

  it('are cut as a group that can be put back, leaving other cuts alone', () => {
    const trim = { start: 0, end: 10 }
    const mine = [{ id: 'mine', start: 5, end: 6 }]
    const cut = removeSilences(findFillers([cue]), mine, [], trim, FILLER_CUT_PREFIX)
    expect(fillerSummary(cut.cuts).count).toBe(2)
    expect(cut.cuts.some((c) => c.id === 'mine')).toBe(true)
    const back = restoreSilences(cut.cuts, cut.splits, FILLER_CUT_PREFIX)
    expect(back.cuts).toEqual(mine)
    expect(back.splits).toEqual([])
  })
})
