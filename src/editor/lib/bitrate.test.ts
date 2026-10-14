import { describe, expect, it } from 'vitest'
import { GIF_FPS, GIF_MAX_WIDTH, estimateBytes, formatBytes, gifFps, gifWidth, pickBitrate } from './bitrate'

describe('pickBitrate', () => {
  it('budgets for frame rate and actual output width', () => {
    expect(pickBitrate(1080, 'high', 60, 1920)).toBe(25_600_000)
    expect(pickBitrate(1080, 'balanced', 30, 2560)).toBeGreaterThan(pickBitrate(1080, 'balanced', 30, 1920))
    expect(pickBitrate(2160, 'high', 60, 20000)).toBe(120_000_000)
    expect(pickBitrate(1080, 'balanced', NaN, NaN)).toBe(8_000_000)
  })
  it('uses the table for known heights', () => {
    expect(pickBitrate(720)).toBe(5_000_000)
    expect(pickBitrate(1080)).toBe(8_000_000)
    expect(pickBitrate(1440)).toBe(14_000_000)
    expect(pickBitrate(2160)).toBe(28_000_000)
  })
  it('scales by pixel count for other heights, clamped', () => {
    expect(pickBitrate(540)).toBe(3_000_000)
    expect(pickBitrate(100)).toBe(2_000_000)
    expect(pickBitrate(5000)).toBe(60_000_000)
  })
  it('falls back to 1080p for garbage', () => {
    expect(pickBitrate(NaN)).toBe(12_000_000)
    expect(pickBitrate(1080, 'small')).toBe(4_000_000)
    expect(pickBitrate(1080, 'high')).toBe(12_800_000)
    expect(pickBitrate(-5)).toBe(12_000_000)
  })
})

describe('gif', () => {
  it('caps the width', () => {
    expect(gifWidth(1920)).toBe(GIF_MAX_WIDTH)
    expect(gifWidth(640)).toBe(640)
    expect(gifWidth(0)).toBe(1)
  })
  it('exports constants used by the export pipeline', () => {
    expect(GIF_FPS).toBe(15)
  })
})

describe('estimateBytes', () => {
  it('is zero for no duration', () => {
    expect(estimateBytes({ kind: 'mp4', height: 1080, width: 1920, seconds: 0 })).toBe(0)
  })
  it('grows with duration and height', () => {
    const a = estimateBytes({ kind: 'mp4', height: 720, width: 1280, seconds: 10 })
    const b = estimateBytes({ kind: 'mp4', height: 1080, width: 1920, seconds: 10 })
    const c = estimateBytes({ kind: 'mp4', height: 1080, width: 1920, seconds: 20 })
    expect(b).toBeGreaterThan(a)
    expect(c).toBeCloseTo(b * 2, -3)
  })
  it('scales gif estimates by the capped width', () => {
    const wide = estimateBytes({ kind: 'gif', height: 1080, width: 1920, seconds: 1 })
    const capped = estimateBytes({ kind: 'gif', height: 540, width: 960, seconds: 1 })
    expect(wide).toBeCloseTo(capped, 0)
  })
})

describe('formatBytes', () => {
  it('formats units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB')
  })
})

describe('chosen GIF settings', () => {
  it('uses the chosen frame rate and width, and never makes the GIF wider than the video', () => {
    expect(gifFps('small', 25)).toBe(25)
    expect(gifFps('high')).toBe(20)
    expect(gifWidth(1920, 'small', 1280)).toBe(1280)
    expect(gifWidth(800, 'high', 1280)).toBe(800)
    expect(gifWidth(1920, 'balanced')).toBe(GIF_MAX_WIDTH)
  })

  it('estimates a larger file for more frames and pixels', () => {
    const base = { kind: 'gif' as const, width: 1920, height: 1080, seconds: 10, quality: 'balanced' as const }
    expect(estimateBytes({ ...base, gif: { fps: 25, width: 1280 } })).toBeGreaterThan(estimateBytes({ ...base, gif: { fps: 10, width: 480 } }))
  })
})
