import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '../shared/types'
import { LAPTOP_BASE_HEIGHT, LAPTOP_BASE_WIDEN, mockupGeometry } from './mockup'

const output = { width: 1920, height: 1080 }
const video = { width: 1920, height: 1080 }

describe('mockupGeometry', () => {
  it('keeps the existing content geometry when mockups are off', () => {
    const g = mockupGeometry(output, video, 0.08, DEFAULT_PROJECT.mockup)
    expect(g.outer).toEqual(g.content)
    expect(g.headerPx).toBe(0)
  })

  it('reserves a header while preserving the video aspect for browser chrome', () => {
    const g = mockupGeometry(output, video, 0.08, { ...DEFAULT_PROJECT.mockup, kind: 'browser' })
    expect(g.headerPx).toBeGreaterThan(0)
    expect(g.content.y).toBeGreaterThan(g.outer.y)
    expect(g.content.width / g.content.height).toBeCloseTo(16 / 9, 4)
    expect(g.content.x).toBeGreaterThanOrEqual(g.outer.x)
  })

  it('centres a tall phone shell and keeps the source inside its screen', () => {
    const g = mockupGeometry(output, { width: 1080, height: 1920 }, 0.08, { ...DEFAULT_PROJECT.mockup, kind: 'phone' })
    expect(g.outer.width / g.outer.height).toBeCloseTo(9 / 19.5, 4)
    expect(g.content.x).toBeGreaterThan(g.outer.x)
    expect(g.content.y).toBeGreaterThan(g.outer.y)
    expect(g.content.x + g.content.width).toBeLessThan(g.outer.x + g.outer.width)
    expect(g.content.y + g.content.height).toBeLessThan(g.outer.y + g.outer.height)
  })
})

describe('the laptop mockup', () => {
  const laptop = { ...DEFAULT_PROJECT.mockup, kind: 'laptop' as const }

  it('keeps the screen the shape of the recording, inside the lid', () => {
    const g = mockupGeometry(output, video, 0.08, laptop)
    expect(g.content.width / g.content.height).toBeCloseTo(16 / 9, 4)
    expect(g.content.x).toBeGreaterThan(g.outer.x)
    expect(g.content.y).toBeGreaterThan(g.outer.y)
    expect(g.content.x + g.content.width).toBeLessThan(g.outer.x + g.outer.width)
    expect(g.content.y + g.content.height).toBeLessThan(g.outer.y + g.outer.height)
  })

  it('leaves room inside the padding for the wider base below the lid', () => {
    for (const out of [output, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const g = mockupGeometry(out, video, 0.08, laptop)
      const pad = 0.08 * Math.min(out.width, out.height)
      const baseW = g.outer.width * LAPTOP_BASE_WIDEN
      const baseBottom = g.outer.y + g.outer.height + g.outer.width * LAPTOP_BASE_HEIGHT
      expect(g.outer.x + g.outer.width / 2 - baseW / 2).toBeGreaterThanOrEqual(pad - 0.5)
      expect(g.outer.x + g.outer.width / 2 + baseW / 2).toBeLessThanOrEqual(out.width - pad + 0.5)
      expect(baseBottom).toBeLessThanOrEqual(out.height - pad + 0.5)
    }
  })
})
