import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '@shared/types'
import { newRecordingProject } from './new-recording-project'
import { mergeProject } from './project-io'

describe('new recording project', () => {
  it('turns click sounds on for new recordings and keeps the recorded fps and cursor skin', () => {
    const p = newRecordingProject({ title: 'Demo', fps: 60, cursorSkin: 'hand' })
    expect(p.cursor.clickSound).toEqual({ enabled: true, style: 'asmr', volume: 0.3 })
    expect(p.zoom.sound).toEqual({ enabled: true, volume: 0.25, style: 'asmr' })
    expect(p.cursor.style).toBe('hand')
    expect(p.output.fps).toBe(60)
    expect(p.title).toBe('Demo')
  })

  it('keeps click sounds on after the editor loads the saved file', () => {
    const saved = JSON.parse(JSON.stringify(newRecordingProject({ title: '', fps: 30, cursorSkin: 'arrow' })))
    expect(mergeProject(saved).cursor.clickSound?.enabled).toBe(true)
    expect(mergeProject(saved).zoom.sound?.enabled).toBe(true)
  })

  it('leaves older recordings without a click-sound setting unchanged (off)', () => {
    const { clickSound: _omit, ...oldCursor } = DEFAULT_PROJECT.cursor
    expect(mergeProject({ version: 1, cursor: oldCursor }).cursor.clickSound?.enabled).toBe(false)
    const { sound: _noSound, ...oldZoom } = DEFAULT_PROJECT.zoom
    expect(mergeProject({ version: 1, zoom: oldZoom }).zoom.sound?.enabled).toBe(false)
  })
})

describe('a planned take', () => {
  const look = {
    scenes: [
      { id: 'i', kind: 'intro' as const, style: 'bold' as const, title: 'Recording → GIF', durationSec: 3 },
      { id: 'o', kind: 'outro' as const, style: 'calm' as const, title: 'Ready to share', durationSec: 3 }
    ],
    background: ['#1f2a44', '#6a3d9a'] as [string, string],
    aspect: '9:16' as const
  }

  it('gets the plan’s cards, gradient background and shape, and is named by its intro', () => {
    const p = newRecordingProject({ title: 'Firefox', fps: 30, cursorSkin: 'hand', look })
    expect(p.scenes.map((s) => s.title)).toEqual(['Recording → GIF', 'Ready to share'])
    expect(p.background).toEqual({ kind: 'gradient', colors: ['#1f2a44', '#6a3d9a'], angle: 135 })
    expect(p.output.aspect).toBe('9:16')
    expect(p.title).toBe('Recording → GIF')
    // And it survives the editor's load.
    expect(mergeProject(JSON.parse(JSON.stringify(p))).scenes).toHaveLength(2)
  })

  it('is an ordinary take without a plan', () => {
    const p = newRecordingProject({ title: 'Firefox', fps: 30, cursorSkin: 'hand', look: null })
    expect(p.scenes).toEqual([])
    expect(p.background).toEqual(DEFAULT_PROJECT.background)
    expect(p.output.aspect).toBe(DEFAULT_PROJECT.output.aspect)
    expect(p.title).toBe('Firefox')
  })
})

describe('the Agent pointer', () => {
  it('is what a new take draws when the record panel picks it, which is now the default', async () => {
    const { DEFAULT_CURSOR_SKIN } = await import('@shared/ipc')
    expect(DEFAULT_CURSOR_SKIN).toBe('agent')
    expect(newRecordingProject({ title: '', fps: 30, cursorSkin: 'agent' }).cursor.style).toBe('agent')
    expect(newRecordingProject({ title: '', fps: 30, cursorSkin: 'halo' }).cursor.style).toBe('halo')
    expect(newRecordingProject({ title: '', fps: 30, cursorSkin: 'star' }).cursor.style).toBe('star')
    expect(newRecordingProject({ title: '', fps: 30, cursorSkin: 'hand' }).cursor.style).toBe('hand')
  })
})
