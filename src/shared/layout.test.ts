import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT, type Project } from './types'
import { WEBCAM_INSET, contentRect, effectiveTrim, outputSize, webcamRect } from './layout'

function project(output: Partial<Project['output']>): Project {
  return { ...DEFAULT_PROJECT, output: { ...DEFAULT_PROJECT.output, ...output } }
}

const hd = { width: 1920, height: 1080 }

describe('outputSize', () => {
  it('uses the project height', () => {
    expect(outputSize(project({ aspect: '16:9', height: 720 }), hd)).toEqual({ width: 1280, height: 720 })
    expect(outputSize(project({ aspect: '16:9', height: 1080 }), hd)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize(project({ aspect: '16:9', height: 1440 }), hd)).toEqual({ width: 2560, height: 1440 })
    expect(outputSize(project({ aspect: '16:9', height: 2160 }), hd)).toEqual({ width: 3840, height: 2160 })
  })

  it('makes the feed and slide shapes', () => {
    expect(outputSize(project({ aspect: '4:5', height: 1080 }), hd)).toEqual({ width: 864, height: 1080 })
    expect(outputSize(project({ aspect: '4:3', height: 1080 }), hd)).toEqual({ width: 1440, height: 1080 })
  })

  it('derives the width from the aspect', () => {
    expect(outputSize(project({ aspect: '1:1', height: 1080 }), hd)).toEqual({ width: 1080, height: 1080 })
    expect(outputSize(project({ aspect: '9:16', height: 1920 as never }), hd)).toEqual({ width: 1080, height: 1920 })
  })

  it('rounds the width to an even number', () => {
    // 1080 * 9/16 = 607.5
    expect(outputSize(project({ aspect: '9:16', height: 1080 }), hd)).toEqual({ width: 608, height: 1080 })
    // 720 * 1001/999 = 721.44
    expect(outputSize(project({ aspect: 'source', height: 720 }), { width: 1001, height: 999 })).toEqual({
      width: 722,
      height: 720
    })
    // 1080 * 1366/768 = 1920.9
    expect(outputSize(project({ aspect: 'source', height: 1080 }), { width: 1366, height: 768 })).toEqual({
      width: 1920,
      height: 1080
    })
  })

  it('keeps the source ratio for aspect source', () => {
    expect(outputSize(project({ aspect: 'source', height: 720 }), { width: 1000, height: 500 })).toEqual({
      width: 1440,
      height: 720
    })
    expect(outputSize(project({ aspect: 'source', height: 720 }), { width: 500, height: 1000 })).toEqual({
      width: 360,
      height: 720
    })
  })

  it('falls back to 16:9 when the source size is unknown', () => {
    expect(outputSize(project({ aspect: 'source', height: 1080 }), { width: 0, height: 0 })).toEqual({
      width: 1920,
      height: 1080
    })
  })
})

describe('contentRect', () => {
  it('fills the output with zero padding and a matching aspect', () => {
    expect(contentRect(hd, hd, 0)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('insets by padding * min side on every side', () => {
    const r = contentRect(hd, hd, 0.08)
    const inset = 0.08 * 1080
    expect(r.y).toBeCloseTo(inset)
    expect(r.height).toBeCloseTo(1080 - 2 * inset)
    // Aspect kept, so the width shrinks by the same factor and gets centred.
    expect(r.width).toBeCloseTo((1080 - 2 * inset) * (16 / 9))
    expect(r.x).toBeCloseTo((1920 - r.width) / 2)
    expect(r.x + r.width).toBeCloseTo(1920 - r.x)
  })

  it('letterboxes a wide source in a square output', () => {
    const r = contentRect({ width: 1080, height: 1080 }, hd, 0)
    expect(r.width).toBeCloseTo(1080)
    expect(r.height).toBeCloseTo(607.5)
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo((1080 - 607.5) / 2)
  })

  it('pillarboxes a tall source in a wide output', () => {
    const r = contentRect(hd, { width: 1080, height: 1920 }, 0)
    expect(r.height).toBeCloseTo(1080)
    expect(r.width).toBeCloseTo(607.5)
    expect(r.y).toBeCloseTo(0)
    expect(r.x).toBeCloseTo((1920 - 607.5) / 2)
  })

  it('combines padding and letterboxing', () => {
    const r = contentRect({ width: 1080, height: 1920 }, hd, 0.1)
    const inset = 108
    expect(r.width).toBeCloseTo(1080 - 2 * inset)
    expect(r.height).toBeCloseTo((1080 - 2 * inset) * (9 / 16))
    expect(r.x).toBeCloseTo(inset)
    expect(r.y).toBeCloseTo((1920 - r.height) / 2)
  })

  it('never exceeds the padded area', () => {
    for (const padding of [0, 0.05, 0.15, 0.3]) {
      for (const source of [hd, { width: 800, height: 1200 }, { width: 3440, height: 1440 }]) {
        const r = contentRect(hd, source, padding)
        const inset = padding * 1080
        expect(r.x).toBeGreaterThanOrEqual(inset - 1e-9)
        expect(r.y).toBeGreaterThanOrEqual(inset - 1e-9)
        expect(r.x + r.width).toBeLessThanOrEqual(1920 - inset + 1e-9)
        expect(r.y + r.height).toBeLessThanOrEqual(1080 - inset + 1e-9)
        expect(r.width / r.height).toBeCloseTo(source.width / source.height)
      }
    }
  })

  it('degrades to an empty centred rect when nothing fits', () => {
    expect(contentRect(hd, hd, 0.5)).toEqual({ x: 960, y: 540, width: 0, height: 0 })
    expect(contentRect(hd, { width: 0, height: 0 }, 0.1)).toEqual({ x: 960, y: 540, width: 0, height: 0 })
  })
})

describe('webcamRect', () => {
  const webcam = (corner: Project['webcam']['corner'], size = 0.22): Project['webcam'] => ({
    enabled: true,
    corner,
    size,
    round: true
  })
  const side = 0.22 * 1080
  const inset = WEBCAM_INSET * 1080

  it('is a square sized from the shorter output side', () => {
    const r = webcamRect(hd, webcam('br'))
    expect(r.width).toBeCloseTo(side)
    expect(r.height).toBeCloseTo(side)
    const tall = webcamRect({ width: 1080, height: 1920 }, webcam('br'))
    expect(tall.width).toBeCloseTo(side)
  })

  it('sits 3% of the shorter side from the chosen corner', () => {
    expect(webcamRect(hd, webcam('br'))).toMatchObject({ x: 1920 - inset - side, y: 1080 - inset - side })
    expect(webcamRect(hd, webcam('bl'))).toMatchObject({ x: inset, y: 1080 - inset - side })
    expect(webcamRect(hd, webcam('tr'))).toMatchObject({ x: 1920 - inset - side, y: inset })
    expect(webcamRect(hd, webcam('tl'))).toMatchObject({ x: inset, y: inset })
  })

  it('scales with webcam.size', () => {
    const r = webcamRect(hd, webcam('tl', 0.5))
    expect(r.width).toBeCloseTo(540)
    expect(r.height).toBeCloseTo(540)
  })

  it('does not depend on webcam.enabled', () => {
    expect(webcamRect(hd, { ...webcam('br'), enabled: false })).toEqual(webcamRect(hd, webcam('br')))
  })
})

describe('effectiveTrim', () => {
  const trimmed = (start: number, end: number): Project => ({ ...DEFAULT_PROJECT, trim: { start, end } })

  it('treats end 0 as the full duration', () => {
    expect(effectiveTrim(trimmed(0, 0), 12.5)).toEqual({ start: 0, end: 12.5 })
    expect(effectiveTrim(trimmed(3, 0), 12.5)).toEqual({ start: 3, end: 12.5 })
  })

  it('passes a valid range through', () => {
    expect(effectiveTrim(trimmed(2, 8), 10)).toEqual({ start: 2, end: 8 })
  })

  it('clamps both ends into [0, duration]', () => {
    expect(effectiveTrim(trimmed(-1, 15), 10)).toEqual({ start: 0, end: 10 })
    expect(effectiveTrim(trimmed(2, 15), 10)).toEqual({ start: 2, end: 10 })
  })

  it('ensures end > start', () => {
    expect(effectiveTrim(trimmed(5, 3), 10)).toEqual({ start: 5, end: 10 })
    expect(effectiveTrim(trimmed(5, 5), 10)).toEqual({ start: 5, end: 10 })
    expect(effectiveTrim(trimmed(12, 0), 10)).toEqual({ start: 0, end: 10 })
    expect(effectiveTrim(trimmed(10, 10), 10)).toEqual({ start: 0, end: 10 })
  })

  it('collapses only for a non-positive duration', () => {
    expect(effectiveTrim(trimmed(1, 2), 0)).toEqual({ start: 0, end: 0 })
  })
})
