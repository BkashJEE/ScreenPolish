import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '@shared/types'
import { lookFromProject } from '@shared/presets'
import { LOOKS_FILE, defaultLookIn, deleteLookIn, loadShelf, saveLookIn, setDefaultLookIn } from './looks'
import { newRecordingProject } from './new-recording-project'

describe('looks on disk', () => {
  it('saves, sets the default, and survives a reload', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-looks-'))
    expect(loadShelf(dir)).toEqual({ presets: [], defaultId: null })
    const look = lookFromProject({ ...DEFAULT_PROJECT, cursor: { ...DEFAULT_PROJECT.cursor, style: 'halo' } })
    const shelf = saveLookIn(dir, 'Calm', look)
    setDefaultLookIn(dir, shelf.presets[0]!.id)
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOOKS_FILE), 'utf8')).presets).toHaveLength(1)
    expect(defaultLookIn(dir)?.cursor.style).toBe('halo')
    deleteLookIn(dir, shelf.presets[0]!.id)
    expect(defaultLookIn(dir)).toBeNull()
  })

  it('starts a new recording in the default look, with a plan still winning for its own take', () => {
    const look = lookFromProject({ ...DEFAULT_PROJECT, cursor: { ...DEFAULT_PROJECT.cursor, style: 'star' }, output: { ...DEFAULT_PROJECT.output, aspect: '1:1' } })
    const plain = newRecordingProject({ title: 't', fps: 60, cursorSkin: 'arrow', style: look })
    expect(plain.cursor.style).toBe('star')
    expect(plain.output.aspect).toBe('1:1')
    const planned = newRecordingProject({ title: 't', fps: 60, cursorSkin: 'arrow', style: look, look: { scenes: [], aspect: '9:16' } })
    expect(planned.output.aspect).toBe('9:16')
    expect(newRecordingProject({ title: 't', fps: 60, cursorSkin: 'halo' }).cursor.style).toBe('halo')
  })
})
