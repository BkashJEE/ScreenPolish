import { describe, expect, it } from 'vitest'
import { takeOutput } from './take-time'
import { DEFAULT_PROJECT, type Project } from './types'

describe("a take's output clock", () => {
  it('runs for the trim less the cuts, plus its cards', () => {
    const p: Project = {
      ...DEFAULT_PROJECT,
      trim: { start: 2, end: 0 },
      cuts: [{ id: 'c', start: 5, end: 7 }],
      scenes: [{ id: 'i', kind: 'intro', style: 'calm', title: 'Hi', durationSec: 3 } as never]
    }
    const out = takeOutput(p, 20)
    expect(out.lengthSec).toBeCloseTo(3 + 18 - 2)
    expect(out.at(1).kind).toBe('scene')
    const r = out.at(3 + 4) as { kind: 'recording'; sourceSec: number }
    // 4 s into the recording: 2..5 is 3 s, then the cut skips to 7, so source 8.
    expect(r.kind).toBe('recording')
    expect(r.sourceSec).toBeCloseTo(8)
  })
})
