import { describe, expect, it } from 'vitest'
import { BUILTIN_LOOKS, BUILTIN_LOOK_PREFIX, builtinLook } from './builtin-looks'
import { CURSOR_SKINS } from './ipc'
import { applyLook, defaultLook, normalizeShelf, setDefaultLook } from './presets'
import { DEFAULT_PROJECT, type Project } from './types'
import { matchZoomTemplate } from './zoom-templates'

describe('built-in looks', () => {
  it('have unique ids that saved looks never use', () => {
    const ids = BUILTIN_LOOKS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith(BUILTIN_LOOK_PREFIX)).toBe(true)
  })

  // That the images exist and are packaged is checked by main/bundled-assets.test.ts.
  it('use a bundled background image', () => {
    for (const { look } of BUILTIN_LOOKS) expect(look.background).toMatchObject({ kind: 'image', imagePath: expect.stringMatching(/^bundled:backgrounds\/.+\.png$/) })
  })

  it('use pointers Capture can show, and a named zoom template', () => {
    for (const { look } of BUILTIN_LOOKS) {
      expect((CURSOR_SKINS as readonly string[]).includes(look.cursor.style)).toBe(true)
      expect(matchZoomTemplate({ ...DEFAULT_PROJECT.zoom, ...look.zoom })?.id).toBe(look.zoom.template)
    }
  })

  it('Studio turns on motion blur, the Star and word-by-word captions', () => {
    const studio = builtinLook('builtin:studio')!.look
    expect(studio.zoom.motionBlur).toBe(0.5)
    expect(studio.cursor.style).toBe('star')
    expect(studio.captions.style).toBe('karaoke')
  })

  it('dress a recording without touching its content or frame rate', () => {
    const take: Project = { ...DEFAULT_PROJECT, title: 'Take', trim: { start: 1, end: 5 }, output: { ...DEFAULT_PROJECT.output, fps: 60 } }
    const out = applyLook(take, builtinLook('builtin:shorts')!.look)
    expect(out.output).toMatchObject({ aspect: '9:16', fps: 60 })
    expect(out.trim).toEqual({ start: 1, end: 5 })
    expect(out.title).toBe('Take')
  })

  it('can be starred for new recordings, and survive a reload', () => {
    const shelf = setDefaultLook({ presets: [], defaultId: null }, 'builtin:studio')
    expect(shelf.defaultId).toBe('builtin:studio')
    expect(defaultLook(shelf)?.cursor.style).toBe('star')
    expect(normalizeShelf(JSON.parse(JSON.stringify(shelf))).defaultId).toBe('builtin:studio')
    expect(setDefaultLook(shelf, 'builtin:nope').defaultId).toBeNull()
    expect(normalizeShelf({ presets: [], defaultId: 'builtin:nope' }).defaultId).toBeNull()
  })
})
