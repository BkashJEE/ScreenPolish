import { describe, expect, it } from 'vitest'
import { SCREEN_BLUR_MAX_TAPS, SCREEN_BLUR_MIN_SPAN_PX, screenBlurMappings } from './render-frame'

const src = { width: 1920, height: 1080 }
const at = (tx: number, ty: number, scale = 1) => ({ tx, ty, scale })

describe('screen motion blur', () => {
  it('draws one copy when the camera is still, so a still frame costs nothing extra', () => {
    expect(screenBlurMappings(at(0, 0), at(0, 0), at(0, 0), src, 1)).toEqual([at(0, 0)])
  })

  it('is off at amount 0 however fast the camera moves', () => {
    expect(screenBlurMappings(at(-200, 0), at(0, 0), at(200, 0), src, 0)).toEqual([at(0, 0)])
  })

  it('smears a pan along its direction, centred on the current frame', () => {
    const shots = screenBlurMappings(at(-30, 0), at(0, 0), at(30, 0), src, 1)
    expect(shots.length).toBeGreaterThan(2)
    expect(shots[0].tx).toBeCloseTo(-15)
    expect(shots.at(-1)!.tx).toBeCloseTo(15)
    expect(shots.every((m) => m.ty === 0 && m.scale === 1)).toBe(true)
  })

  it('smears a zoom outward, because scale and offset move together', () => {
    const shots = screenBlurMappings(at(0, 0, 1), at(-20, -10, 1.02), at(-40, -20, 1.04), src, 1)
    expect(shots[0].scale).toBeLessThan(1.02)
    expect(shots.at(-1)!.scale).toBeGreaterThan(1.02)
    expect(shots.length).toBeGreaterThan(2)
  })

  it('scales the shutter with the amount', () => {
    const half = screenBlurMappings(at(-30, 0), at(0, 0), at(30, 0), src, 0.5)
    expect(half[0].tx).toBeCloseTo(-7.5)
    expect(half.at(-1)!.tx).toBeCloseTo(7.5)
  })

  it('caps the copies on a very fast move', () => {
    expect(screenBlurMappings(at(-900, 0), at(0, 0), at(900, 0), src, 1)).toHaveLength(SCREEN_BLUR_MAX_TAPS)
  })

  it('ignores sub-pixel motion', () => {
    expect(screenBlurMappings(at(-0.4, 0), at(0, 0), at(0.4, 0), src, 1)).toHaveLength(1)
  })

  it('skips smears too short to see, so a slow follow drift costs nothing in export', () => {
    expect(screenBlurMappings(at(-2, 0), at(0, 0), at(2, 0), src, 1)).toHaveLength(1)
    expect(screenBlurMappings(at(-SCREEN_BLUR_MIN_SPAN_PX, 0), at(0, 0), at(SCREEN_BLUR_MIN_SPAN_PX, 0), src, 1).length).toBeGreaterThan(1)
  })
})
