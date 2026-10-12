import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '../../shared/types'
import { BRAND_THEMES } from '../../brand'
import { BUNDLED_BACKGROUNDS, SOLID_PRESETS, migrateCursorStyle, backgroundCss, imageUrlForPath, matchPreset, matchSolidPreset, normalizeProject, patchGroup, projectEquals } from './project'

describe('bundled background themes', () => {
  /** Drawn by scripts/backgrounds.py, so every build ships these. */
  const DRAWN = ['neon', 'prism', 'sunburst', 'electric', 'citrus', 'holo', 'candy', 'aurora', 'violet-haze', 'dawn', 'ember', 'slate-mesh', 'spotlight', 'grid', 'daylight']

  it('ships the pack themes this build has, plus the drawn set and Omarchy, with export-safe URLs', () => {
    // A build without a pack (the public Omarchy edition) ships no brand themes.
    expect(BUNDLED_BACKGROUNDS.map((b) => b.id)).toEqual([...BRAND_THEMES.map((t) => t.id), ...DRAWN, 'omarchy'])
    for (const background of BUNDLED_BACKGROUNDS) {
      const relative = background.path.replace('bundled:', '')
      expect(imageUrlForPath(background.path)).toBe(`polish://asset/${relative}`)
    }
  })

  it('gives every background its own id and its own file', () => {
    expect(new Set(BUNDLED_BACKGROUNDS.map((b) => b.id)).size).toBe(BUNDLED_BACKGROUNDS.length)
    expect(new Set(BUNDLED_BACKGROUNDS.map((b) => b.path)).size).toBe(BUNDLED_BACKGROUNDS.length)
  })
})

describe('click timing on load', () => {
  it('keeps a saved click timing to the offered range and leaves it absent when unset', () => {
    expect(normalizeProject({ cursor: { ...DEFAULT_PROJECT.cursor, syncSec: 9 } }).cursor.syncSec).toBe(1.5)
    expect(normalizeProject({ cursor: { ...DEFAULT_PROJECT.cursor, syncSec: 0.8 } }).cursor.syncSec).toBe(0.8)
    expect(normalizeProject({ cursor: { ...DEFAULT_PROJECT.cursor } }).cursor.syncSec).toBeUndefined()
  })
})

describe('patchGroup', () => {
  it('returns a new project with the group patched and nothing else touched', () => {
    const next = patchGroup(DEFAULT_PROJECT, 'frame', { radius: 24 })
    expect(next).not.toBe(DEFAULT_PROJECT)
    expect(next.frame).toEqual({ ...DEFAULT_PROJECT.frame, radius: 24 })
    expect(next.cursor).toBe(DEFAULT_PROJECT.cursor)
    expect(DEFAULT_PROJECT.frame.radius).toBe(16)
  })
  it('returns the same reference when nothing changes', () => {
    expect(patchGroup(DEFAULT_PROJECT, 'frame', { radius: 16 })).toBe(DEFAULT_PROJECT)
  })
})

describe('normalizeProject', () => {
  it('keeps old perspective by default and preserves the unified opt-in', () => {
    expect(normalizeProject({}).zoom.perspective).toBe('legacy')
    expect(normalizeProject({ zoom: { ...DEFAULT_PROJECT.zoom, perspective: 'unified' } }).zoom.perspective).toBe('unified')
    expect(normalizeProject({ zoom: { perspective: 'invalid' } } as never).zoom.perspective).toBe('legacy')
  })
  it('fills missing groups with defaults', () => {
    const p = normalizeProject({ version: 1, trim: { start: 1, end: 0 } })
    expect(p.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(p.trim).toEqual({ start: 1, end: 0 })
    expect(p.output).toEqual(DEFAULT_PROJECT.output)
    expect(p.audio).toEqual(DEFAULT_PROJECT.audio)
    expect(p.mockup).toEqual(DEFAULT_PROJECT.mockup)
    expect(p.animation).toEqual(DEFAULT_PROJECT.animation)
    expect(p.zoom.manual).toEqual([])
  })

  it('normalizes legacy and malformed crops', () => {
    expect(normalizeProject({}).crop).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(normalizeProject({ crop: { x: -0.1, y: 0.2, width: 1.5, height: 1 } } as never).crop).toEqual({ x: 0, y: 0.2, width: 1, height: 0.8 })
    expect(normalizeProject({ crop: { x: 0, y: 0, width: Number.NEGATIVE_INFINITY, height: 1 } } as never).crop).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('normalizes legacy and malformed animation settings', () => {
    const p = normalizeProject({
      animation: { style: 'slide' as never, durationSec: Number.NaN, strength: Number.POSITIVE_INFINITY }
    })
    expect(p.animation).toEqual(DEFAULT_PROJECT.animation)

    const bounded = normalizeProject({
      animation: { style: 'fade', durationSec: -5, strength: 4 }
    })
    expect(bounded.animation).toEqual({ style: 'fade', durationSec: 0, strength: 1 })

    const finite = normalizeProject({
      animation: { style: 'rise', durationSec: Number.NEGATIVE_INFINITY, strength: Number.NaN }
    })
    expect(finite.animation).toEqual({
      ...DEFAULT_PROJECT.animation,
      style: 'rise'
    })
  })
  it('copies arrays so later edits do not alias the source', () => {
    const src = { zoom: { ...DEFAULT_PROJECT.zoom, manual: [], removedAuto: ['a'] } }
    const p = normalizeProject(src)
    expect(p.zoom.removedAuto).toEqual(['a'])
    expect(p.zoom.removedAuto).not.toBe(src.zoom.removedAuto)
  })
  it('defaults legacy frame offsets to zero', () => {
    const p = normalizeProject({})
    expect(p.frame.offsetX).toBe(0)
    expect(p.frame.offsetY).toBe(0)
  })
  it('clamps finite frame sizes and defaults malformed values to 100%', () => {
    expect(normalizeProject({ frame: { size: 0.25 } } as never).frame.size).toBe(0.5)
    expect(normalizeProject({ frame: { size: 2 } } as never).frame.size).toBe(1.5)
    expect(normalizeProject({ frame: { size: Number.NaN } } as never).frame.size).toBe(1)
    expect(normalizeProject({ frame: { size: Number.POSITIVE_INFINITY } } as never).frame.size).toBe(1)
    expect(normalizeProject({ frame: { size: 'large' } } as never).frame.size).toBe(1)
  })

  it('clamps finite frame offsets and rejects non-finite values', () => {
    const p = normalizeProject({ frame: { offsetX: 2, offsetY: -2 } } as never)
    expect(p.frame.offsetX).toBe(0.5)
    expect(p.frame.offsetY).toBe(-0.5)
    const malformed = normalizeProject({ frame: { offsetX: Number.NaN, offsetY: Number.POSITIVE_INFINITY } } as never)
    expect(malformed.frame.offsetX).toBe(0)
    expect(malformed.frame.offsetY).toBe(0)
  })
  it('accepts null', () => {
    expect(normalizeProject(null)).toEqual({ ...DEFAULT_PROJECT, zoom: { ...DEFAULT_PROJECT.zoom, perspective: 'legacy', manual: [], removedAuto: [] } })
  })
})

describe('presets', () => {
  it('matches the default background to the first solid preset', () => {
    expect(matchSolidPreset(DEFAULT_PROJECT.background)).toBe(SOLID_PRESETS[0])
    expect(matchPreset(DEFAULT_PROJECT.background)).toBeNull()
  })
  it('returns null for solid or custom', () => {
    expect(matchPreset({ kind: 'solid', colors: ['#000'], angle: 0 })).toBeNull()
    expect(matchPreset({ kind: 'gradient', colors: ['#010203', '#040506'], angle: 12 })).toBeNull()
  })
  it('renders css for gradients and solids', () => {
    expect(backgroundCss({ kind: 'solid', colors: ['#123456'], angle: 0 })).toBe('#123456')
    expect(backgroundCss({ kind: 'gradient', colors: ['#000', '#fff'], angle: 90 })).toBe('linear-gradient(90deg, #000, #fff)')
    expect(backgroundCss({ kind: 'gradient', colors: [], angle: 90 })).toBe('#000000')
  })
})

describe('imageUrlForPath', () => {
  it('passes urls through', () => {
    expect(imageUrlForPath('polish://media/x.png')).toBe('polish://media/x.png')
    expect(imageUrlForPath('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  })
  it('encodes filesystem paths the way main decodes them (base64url of utf-8)', () => {
    const path = 'C:\\Users\\me\\bg image ü.png'
    const bytes = new TextEncoder().encode(path)
    const expected = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(imageUrlForPath(path)).toBe(`polish://image/${expected}`)
  })
  it('does not mistake a drive letter for a scheme', () => {
    expect(imageUrlForPath('D:/pics/a.png').startsWith('polish://image/')).toBe(true)
  })
})

describe('projectEquals', () => {
  it('compares structurally', () => {
    expect(projectEquals(DEFAULT_PROJECT, { ...DEFAULT_PROJECT })).toBe(true)
    expect(projectEquals(DEFAULT_PROJECT, patchGroup(DEFAULT_PROJECT, 'frame', { radius: 1 }))).toBe(false)
  })
})

describe('click sound settings', () => {
  it('are off by default and keep an explicit Cursor setting', () => {
    expect(normalizeProject({}).cursor.clickSound).toEqual({ enabled: false, style: 'asmr', volume: 0.3 })
    expect(normalizeProject({ cursor: { ...DEFAULT_PROJECT.cursor, clickSound: { enabled: true, style: 'tick', volume: 2 } } }).cursor.clickSound).toEqual({ enabled: true, style: 'tick', volume: 1 })
  })

  it('migrate the on/off switch saved by early window-tracking builds', () => {
    expect(normalizeProject({ audio: { ...DEFAULT_PROJECT.audio, clickSounds: true } }).cursor.clickSound?.enabled).toBe(true)
    expect(normalizeProject({ audio: { ...DEFAULT_PROJECT.audio, clickSounds: false } }).cursor.clickSound?.enabled).toBe(false)
  })
})

describe('migrateCursorStyle', () => {
  it("loads the sprite pointer saved under its old name", () => {
    expect(migrateCursorStyle('hermes')).toBe('sprite')
  })

  it('keeps every current style and falls back for anything else', () => {
    for (const style of ['arrow', 'dot', 'hand', 'bobbing', 'sprite'] as const) expect(migrateCursorStyle(style)).toBe(style)
    expect(migrateCursorStyle('nonsense')).toBe(DEFAULT_PROJECT.cursor.style)
    expect(migrateCursorStyle(undefined)).toBe(DEFAULT_PROJECT.cursor.style)
  })
})
