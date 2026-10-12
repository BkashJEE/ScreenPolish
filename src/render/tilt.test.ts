import { describe, expect, it } from 'vitest'
import { MAX_STRIPS, drawTilted, hasTilt, projectCard, quadBounds, type Ctx2D } from './tilt'

const rect = { x: 100, y: 50, width: 800, height: 450 }

function fakeCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const ctx = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === 'canvas') return { width: 1000, height: 600 }
        return (...args: unknown[]) => {
          calls.push({ name, args })
        }
      },
      set() {
        return true
      }
    }
  ) as unknown as Ctx2D
  return { ctx, calls }
}

describe('projectCard', () => {
  it('is the rect itself with no tilt', () => {
    const q = projectCard(rect, 0, 0)
    expect(q.tl).toEqual({ x: 100, y: 50 })
    expect(q.br).toEqual({ x: 900, y: 500 })
  })

  it('brings the left edge toward the viewer for a positive tiltX', () => {
    const q = projectCard(rect, 12, 0)
    const leftHeight = q.bl.y - q.tl.y
    const rightHeight = q.br.y - q.tr.y
    expect(leftHeight).toBeGreaterThan(rightHeight)
    expect(leftHeight).toBeGreaterThan(rect.height)
    expect(rightHeight).toBeLessThan(rect.height)
    // Symmetric around the centre line.
    expect((q.tl.y + q.bl.y) / 2).toBeCloseTo(rect.y + rect.height / 2, 6)
  })

  it('mirrors for a negative tiltX and swaps axes for tiltY', () => {
    const l = projectCard(rect, -12, 0)
    expect(l.br.y - l.tr.y).toBeGreaterThan(l.bl.y - l.tl.y)
    const up = projectCard(rect, 0, 10)
    const topWidth = up.tr.x - up.tl.x
    const bottomWidth = up.br.x - up.bl.x
    expect(topWidth).toBeGreaterThan(bottomWidth)
  })

  it('keeps the quad close to the rect centre so the frame does not wander', () => {
    const q = projectCard(rect, 9, -7)
    const b = quadBounds(q)
    expect(Math.abs(b.x + b.width / 2 - (rect.x + rect.width / 2))).toBeLessThan(rect.width * 0.03)
    expect(Math.abs(b.y + b.height / 2 - (rect.y + rect.height / 2))).toBeLessThan(rect.height * 0.03)
  })
})

describe('drawTilted', () => {
  /** The body strips: the draws that take the full source height (vertical) or width (horizontal). */
  const bodies = (calls: Array<{ name: string; args: unknown[] }>, full: number, at: 4 | 3) =>
    calls.filter((c) => c.name === 'drawImage' && (c.args as number[])[at] === full).map((c) => c.args as number[])

  it('draws one strip per slice, vertically for tiltX', () => {
    const { ctx, calls } = fakeCtx()
    drawTilted(ctx, {} as CanvasImageSource, { width: 800, height: 450 }, rect, 10, 0, 120)
    const draws = bodies(calls, 450, 4)
    expect(draws).toHaveLength(120)
    // First strip is taller than the last (left edge near the viewer).
    expect(draws[0]![8]).toBeGreaterThan(draws[119]![8])
    // Source x advances across the card.
    expect(draws[0]![1]).toBe(0)
    // Within half a source column: joins are snapped to whole output pixels.
    expect(draws[119]![1]).toBeCloseTo((119 / 120) * 800, 0)
  })

  it('meets neighbouring strips on whole pixels, with no gap or overlap', () => {
    const { ctx, calls } = fakeCtx()
    drawTilted(ctx, {} as CanvasImageSource, { width: 800, height: 450 }, rect, 9, 2, 120)
    const draws = bodies(calls, 450, 4)
    for (const d of draws) {
      expect(Number.isInteger(d[5])).toBe(true)
      expect(Number.isInteger(d[5] + d[7])).toBe(true)
    }
    for (let i = 1; i < draws.length; i++) expect(draws[i]![5]).toBe(draws[i - 1]![5] + draws[i - 1]![7])
    // Source columns run edge to edge with nothing skipped.
    expect(draws[0]![1]).toBe(0)
    const last = draws.at(-1)!
    expect(last[1] + last[3]).toBeCloseTo(800, 6)
  })

  it('draws horizontal strips for a dominant tiltY', () => {
    const { ctx, calls } = fakeCtx()
    drawTilted(ctx, {} as CanvasImageSource, { width: 800, height: 450 }, rect, 0, 8, 120)
    const draws = bodies(calls, 800, 3)
    expect(draws).toHaveLength(120)
    expect(draws[0]![2]).toBe(0) // source y starts at 0
    expect(draws[0]![7]).toBeGreaterThan(rect.width) // top strip wider than the card
  })

  it('cuts the stepping edges with a clip and bleeds each strip past them', () => {
    const { ctx, calls } = fakeCtx()
    drawTilted(ctx, {} as CanvasImageSource, { width: 800, height: 450 }, rect, 10, 0, 120)
    const clip = calls.findIndex((c) => c.name === 'clip')
    const firstDraw = calls.findIndex((c) => c.name === 'drawImage')
    expect(clip).toBeGreaterThanOrEqual(0)
    expect(clip).toBeLessThan(firstDraw)
    // Each strip also repeats its first and last source rows beyond the edge.
    const rows = calls.filter((c) => c.name === 'drawImage' && (c.args as number[])[4] === 1).map((c) => (c.args as number[])[2])
    expect(rows.filter((y) => y === 0)).toHaveLength(120)
    expect(rows.filter((y) => y === 449)).toHaveLength(120)
  })

  it('uses more strips for a steep tilt, within a cap', () => {
    const { ctx, calls } = fakeCtx()
    drawTilted(ctx, {} as CanvasImageSource, { width: 800, height: 450 }, rect, 30, 0, 4)
    const n = bodies(calls, 450, 4).length
    expect(n).toBeGreaterThan(4)
    expect(n).toBeLessThanOrEqual(MAX_STRIPS)
  })

  it('hasTilt ignores noise', () => {
    expect(hasTilt(0, 0)).toBe(false)
    expect(hasTilt(undefined, undefined)).toBe(false)
    expect(hasTilt(0.001, 0)).toBe(false)
    expect(hasTilt(3, 0)).toBe(true)
  })
})
