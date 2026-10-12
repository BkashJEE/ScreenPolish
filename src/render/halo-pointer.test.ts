import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../shared/ctx2d'
import { HALO_MAX_OFFSET, drawCursor, drawHalo, haloPressAt, haloRingOffset } from './render-frame'

/** Records arcs, fills and strokes; enough of a 2D context for the Halo. */
function recorder() {
  const log: Array<{ op: string; style?: unknown; width?: number; r?: number; x?: number; y?: number }> = []
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {},
    arc(x: number, y: number, r: number) { log.push({ op: 'arc', x, y, r }) },
    fill() { log.push({ op: 'fill', style: ctx.fillStyle }) },
    stroke() { log.push({ op: 'stroke', style: ctx.strokeStyle, width: ctx.lineWidth }) }
  }
  return { ctx: ctx as unknown as Ctx2D, log }
}

describe('Halo pointer', () => {
  it('draws the ring where it trails and the dot on the hotspot', () => {
    const { ctx, log } = recorder()
    drawHalo(ctx, 100, 100, 90, 95, 24, 0)
    const arcs = log.filter((l) => l.op === 'arc')
    expect(arcs[0]).toMatchObject({ x: 90, y: 95 })
    expect(arcs[1]).toMatchObject({ x: 100, y: 100 })
    expect(arcs[0]!.r!).toBeGreaterThan(arcs[1]!.r! * 2)
    // A dark edge under a white ring, so it holds on white pages.
    const strokes = log.filter((l) => l.op === 'stroke')
    expect(strokes[0]!.width!).toBeGreaterThan(strokes[1]!.width!)
    expect(String(strokes[1]!.style)).toContain('255, 255, 255')
  })

  it('tightens the ring on a press', () => {
    const open = recorder()
    const pressed = recorder()
    drawHalo(open.ctx, 0, 0, 0, 0, 24, 0)
    drawHalo(pressed.ctx, 0, 0, 0, 0, 24, 1)
    expect(pressed.log[0]!.r!).toBeLessThan(open.log[0]!.r!)
  })

  it('colours the dot, falling back to white', () => {
    const coloured = recorder()
    drawHalo(coloured.ctx, 0, 0, 0, 0, 24, 0, '#ffbd85')
    expect(coloured.log.filter((l) => l.op === 'fill').at(-1)!.style).toBe('#ffbd85')
    for (const bad of [undefined, 'red', 'javascript:']) {
      const { ctx, log } = recorder()
      drawHalo(ctx, 0, 0, 0, 0, 24, 0, bad)
      expect(log.filter((l) => l.op === 'fill').at(-1)!.style).toBe('#ffffff')
    }
  })

  it('draws centred when there is no path to trail along', () => {
    const { ctx, log } = recorder()
    drawCursor(ctx, 50, 50, 24, 'halo')
    const arcs = log.filter((l) => l.op === 'arc')
    expect(arcs).toHaveLength(2)
    expect(arcs[0]).toMatchObject({ x: 0, y: 0 })
    expect(arcs[1]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('haloPressAt', () => {
  it('closes fast on the click and opens again within 0.4 s', () => {
    expect(haloPressAt(0)).toBe(0)
    expect(haloPressAt(0.08)).toBe(1)
    expect(haloPressAt(0.2)).toBeGreaterThan(0)
    expect(haloPressAt(0.2)).toBeLessThan(1)
    expect(haloPressAt(0.38)).toBe(0)
    for (const none of [-1, NaN, Infinity]) expect(haloPressAt(none)).toBe(0)
  })
})

describe('haloRingOffset', () => {
  it('keeps short lags and caps long ones in the same direction', () => {
    expect(haloRingOffset(3, 4, 24)).toEqual({ dx: 3, dy: 4 })
    const far = haloRingOffset(300, 400, 24)
    expect(Math.hypot(far.dx, far.dy)).toBeCloseTo(HALO_MAX_OFFSET * 24)
    expect(far.dx / far.dy).toBeCloseTo(0.75)
  })
})
