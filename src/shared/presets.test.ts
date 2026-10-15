import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT, type Project } from './types'
import { MAX_LOOKS, applyLook, defaultLook, deleteLook, lookFromProject, normalizeShelf, saveLook, setDefaultLook, type LookShelf } from './presets'

const styled: Project = {
  ...DEFAULT_PROJECT,
  background: { kind: 'image', colors: ['#000000'], angle: 0, imagePath: 'bundled:backgrounds/neon.png' },
  frame: { ...DEFAULT_PROJECT.frame, padding: 0.12, radius: 24 },
  cursor: { ...DEFAULT_PROJECT.cursor, style: 'star', size: 1.6, syncSec: 0.8 },
  zoom: { ...DEFAULT_PROJECT.zoom, scale: 2.4, manual: [{ id: 'z', start: 1, end: 2, scale: 2, cx: 10, cy: 10 } as never] },
  captions: { enabled: true, cues: [{ id: 'c', start: 0, end: 1, text: 'hi' }], size: 1.3, position: 'top', style: 'bold', highlight: '#00ff88' },
  webcam: { ...DEFAULT_PROJECT.webcam, enabled: true, mirror: true, corner: 'tl' },
  output: { ...DEFAULT_PROJECT.output, aspect: '9:16' }
}

describe('looks', () => {
  it('carry the style and leave what belongs to the recording', () => {
    const target: Project = {
      ...DEFAULT_PROJECT,
      title: 'Another take',
      trim: { start: 2, end: 9 },
      cursor: { ...DEFAULT_PROJECT.cursor, syncSec: 0.3 },
      zoom: { ...DEFAULT_PROJECT.zoom, manual: [] },
      captions: { enabled: false, cues: [{ id: 'x', start: 3, end: 4, text: 'mine' }], size: 1, position: 'bottom' },
      webcam: { ...DEFAULT_PROJECT.webcam, enabled: false }
    }
    const out = applyLook(target, lookFromProject(styled))
    expect(out.background.imagePath).toBe('bundled:backgrounds/neon.png')
    expect(out.frame.radius).toBe(24)
    expect(out.cursor).toMatchObject({ style: 'star', size: 1.6, syncSec: 0.3 })
    expect(out.zoom.scale).toBe(2.4)
    expect(out.zoom.manual).toEqual([])
    expect(out.captions).toMatchObject({ enabled: false, size: 1.3, position: 'top', style: 'bold', highlight: '#00ff88' })
    expect(out.captions!.cues.map((c) => c.text)).toEqual(['mine'])
    expect(out.webcam).toMatchObject({ enabled: false, mirror: true, corner: 'tl' })
    expect(out.output.aspect).toBe('9:16')
    expect(out.title).toBe('Another take')
    expect(out.trim).toEqual({ start: 2, end: 9 })
  })

  it('are copies, so editing the project later does not change a saved look', () => {
    const look = lookFromProject(styled)
    const out = applyLook(DEFAULT_PROJECT, look)
    out.frame.radius = 2
    expect(look.frame.radius).toBe(24)
  })
})

describe('the shelf', () => {
  const look = lookFromProject(styled)
  let n = 0
  const id = () => `id-${++n}`

  it('saves by name, replacing a look with the same name', () => {
    let shelf: LookShelf = { presets: [], defaultId: null }
    shelf = saveLook(shelf, ' Launch ', look, id)
    shelf = saveLook(shelf, 'launch', applyLook(DEFAULT_PROJECT, look) && lookFromProject(DEFAULT_PROJECT), id)
    expect(shelf.presets).toHaveLength(1)
    expect(shelf.presets[0]!.name).toBe('launch')
    expect(shelf.presets[0]!.look.cursor.style).toBe(DEFAULT_PROJECT.cursor.style)
    expect(() => saveLook(shelf, '   ', look, id)).toThrow('name')
  })

  it('has a limit', () => {
    let shelf: LookShelf = { presets: [], defaultId: null }
    for (let i = 0; i < MAX_LOOKS; i++) shelf = saveLook(shelf, `Look ${i}`, look, id)
    expect(() => saveLook(shelf, 'One more', look, id)).toThrow('delete one first')
  })

  it('keeps a default only while that look exists', () => {
    let shelf = saveLook({ presets: [], defaultId: null }, 'Launch', look, id)
    const lookId = shelf.presets[0]!.id
    shelf = setDefaultLook(shelf, lookId)
    expect(defaultLook(shelf)?.cursor.style).toBe('star')
    expect(setDefaultLook(shelf, 'nope').defaultId).toBeNull()
    expect(deleteLook(shelf, lookId)).toEqual({ presets: [], defaultId: null })
  })

  it('reads a damaged file as far as it can', () => {
    expect(normalizeShelf('garbage')).toEqual({ presets: [], defaultId: null })
    const shelf = normalizeShelf({ presets: [{ id: 'a', name: 'Good', look }, { id: 'b', name: '', look }, { id: 'c', name: 'No look' }], defaultId: 'b' })
    expect(shelf.presets.map((p) => p.name)).toEqual(['Good'])
    expect(shelf.defaultId).toBeNull()
  })
})
