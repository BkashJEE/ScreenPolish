import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../shared/ctx2d'
import { STAR_BURST_SEC, STAR_POINTER_COLOR, STAR_TRAIL_MAX, drawCursor, drawStar, drawStarBurst, drawStarTrail } from './render-frame'

/** Records fills, strokes and gradient stops; enough of a 2D context for the Star. */
function recorder() {
  const log: Array<{ op: string; style?: unknown; width?: number }> = []
  const stops: string[] = []
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, closePath() {},
    moveTo() {}, quadraticCurveTo() {}, arc() {},
    lineTo(x: number, y: number) { log.push({ op: `lineTo ${x},${y}` }) },
    fill() { log.push({ op: 'fill', style: ctx.fillStyle }) },
    stroke() { log.push({ op: 'stroke', style: ctx.strokeStyle, width: ctx.lineWidth }) },
    createRadialGradient() { return { addColorStop: (_o: number, c: string) => stops.push(c) } }
  }
  return { ctx: ctx as unknown as Ctx2D, log, stops }
}

const gold = 'rgba(245, 197, 66'

describe('Star pointer', () => {
  it('draws a glow, a gold body and an edge', () => {
    const { ctx, log, stops } = recorder()
    drawStar(ctx, 100, 100, 32)
    expect(log.map((l) => l.op)).toEqual(['fill', 'fill', 'stroke'])
    // The body runs from near-white at the centre to a deeper gold at the tips.
    expect(stops.some((s) => s.startsWith('rgba(254,'))).toBe(true)
  })

  it('takes a colour, falling back to gold', () => {
    const custom = recorder()
    drawStar(custom.ctx, 0, 0, 32, '#ff4d8d')
    expect(custom.stops.join(' ')).toContain('rgba(255, 1')
    for (const bad of [undefined, 'gold', '#12345']) {
      const { ctx, stops } = recorder()
      drawStar(ctx, 0, 0, 32, bad)
      expect(stops.some((s) => s.startsWith(gold))).toBe(true)
    }
    expect(STAR_POINTER_COLOR).toBe('#f5c542')
  })

  it('draws through drawCursor too', () => {
    const { ctx, log } = recorder()
    drawCursor(ctx, 10, 10, 32, 'star')
    expect(log.length).toBeGreaterThan(0)
  })
})

describe('Star trail', () => {
  const line = (n: number, step: number) => Array.from({ length: n }, (_, i) => ({ x: 100 + i * step, y: 100 }))

  it('has no tail while the pointer rests', () => {
    const { ctx, log } = recorder()
    drawStarTrail(ctx, line(13, 0), 32)
    expect(log).toEqual([])
  })

  it('tapers and fades away from the star, with sparkles along it', () => {
    const { ctx, log } = recorder()
    drawStarTrail(ctx, line(13, 10), 32)
    const strokes = log.filter((l) => l.op === 'stroke')
    expect(strokes.length).toBeGreaterThan(3)
    expect(strokes[0]!.width!).toBeGreaterThan(strokes.at(-1)!.width!)
    expect(log.filter((l) => l.op === 'fill').length).toBeGreaterThan(0)
  })

  it('stays a short streak even when the pointer jumps across the screen', () => {
    const { ctx, log } = recorder()
    drawStarTrail(ctx, [{ x: 100, y: 100 }, { x: 1500, y: 100 }, { x: 1600, y: 100 }], 32)
    const xs = log.filter((l) => l.op.startsWith('lineTo')).map((l) => Number(l.op.split(' ')[1]!.split(',')[0]))
    expect(Math.max(...xs)).toBeCloseTo(100 + STAR_TRAIL_MAX * 32)
  })
})

describe('Star burst', () => {
  it('throws six sparkles and is gone once the burst is over', () => {
    const fresh = recorder()
    drawStarBurst(fresh.ctx, 0, 0, 32, 0.1, 0)
    expect(fresh.log.filter((l) => l.op === 'fill')).toHaveLength(6)
    for (const age of [STAR_BURST_SEC, -0.1, NaN]) {
      const { ctx, log } = recorder()
      drawStarBurst(ctx, 0, 0, 32, age, 0)
      expect(log).toEqual([])
    }
  })
})
