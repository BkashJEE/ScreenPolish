import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../shared/ctx2d'
import { DEFAULT_PROJECT, type Project } from '../shared/types'
import { drawWebcam } from './render-frame'

/** Records every call and property set, which is all these checks need. */
function fakeCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const sets: Array<{ name: string; value: unknown }> = []
  const ctx = new Proxy({}, {
    get(_t, name: string) {
      if (name === 'canvas') return { width: 1920, height: 1080 }
      if (name === 'getTransform') return () => ({ a: 1, d: 1, e: 0, f: 0 })
      if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => ({ addColorStop() {} })
      return (...args: unknown[]) => { calls.push({ name, args }) }
    },
    set(_t, name: string, value) { sets.push({ name, value }); return true }
  }) as unknown as Ctx2D
  return { ctx, calls, sets }
}

const camera = { width: 640, height: 480 } as unknown as CanvasImageSource
const cfg = (patch: Partial<Project['webcam']> = {}): Project['webcam'] => ({ ...DEFAULT_PROJECT.webcam, ...patch })

describe('drawWebcam', () => {
  it('mirrors about the bubble only when asked', () => {
    const plain = fakeCtx()
    drawWebcam(plain.ctx, { width: 1920, height: 1080 }, camera, cfg(), 1080)
    expect(plain.calls.some((c) => c.name === 'scale' && c.args[0] === -1)).toBe(false)
    const mirrored = fakeCtx()
    drawWebcam(mirrored.ctx, { width: 1920, height: 1080 }, camera, cfg({ mirror: true }), 1080)
    expect(mirrored.calls.some((c) => c.name === 'scale' && c.args[0] === -1 && c.args[1] === 1)).toBe(true)
  })

  it('scales the shadow, down to none', () => {
    const shadowAlpha = (shadow?: number) => {
      const { ctx, sets } = fakeCtx()
      drawWebcam(ctx, { width: 1920, height: 1080 }, camera, cfg({ shadow }), 1080)
      return String(sets.find((s) => s.name === 'shadowColor')!.value)
    }
    expect(shadowAlpha()).toBe('rgba(0, 0, 0, 0.350)')
    expect(shadowAlpha(0.5)).toBe('rgba(0, 0, 0, 0.175)')
    expect(shadowAlpha(0)).toBe('rgba(0, 0, 0, 0.000)')
  })
})
