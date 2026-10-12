import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: (k: string) => (k === 'videos' ? path.resolve('videos-home') : path.resolve('userdata-home')) } }))

import { CURSOR_SKINS } from '@shared/ipc'
import { defaultRecordingsRoot, sanitizeSettings } from './settings'

/** Windows hides/redraws; Hyprland's portal omits/redraws; macOS keeps the real cursor. */
const defaultMode = process.platform === 'darwin' ? 'system' : 'overlay'

describe('sanitizeSettings', () => {
  const fallback = path.resolve('videos-home', 'ScreenPolish')
  it('keeps an absolute recordings root and normalizes it', () => {
    const messy = path.resolve('clips-root', '..', 'recordings') + path.sep
    expect(sanitizeSettings({ recordingsRoot: messy }, fallback).recordingsRoot).toBe(path.normalize(messy))
    const clean = path.resolve('clips-root')
    expect(sanitizeSettings({ recordingsRoot: clean }, fallback).recordingsRoot).toBe(clean)
  })
  it('falls back for relative, empty, or garbage values', () => {
    expect(sanitizeSettings({ recordingsRoot: 'clips' }, fallback).recordingsRoot).toBe(fallback)
    expect(sanitizeSettings({ recordingsRoot: '' }, fallback).recordingsRoot).toBe(fallback)
    expect(sanitizeSettings(null, fallback).recordingsRoot).toBe(fallback)
    expect(sanitizeSettings({ recordingsRoot: 42 }, fallback).recordingsRoot).toBe(fallback)
  })
  it('defaults the pointer to the overlay on Windows and the real cursor elsewhere', () => {
    expect(sanitizeSettings({}, fallback).cursorMode).toBe(defaultMode)
    expect(sanitizeSettings({ cursorMode: 'nonsense' }, fallback).cursorMode).toBe(defaultMode)
  })
  it('forces the rendered pointer on Linux and honours system mode elsewhere', () => {
    expect(sanitizeSettings({ cursorMode: 'system' }, fallback).cursorMode).toBe(process.platform === 'linux' ? 'overlay' : 'system')
  })
  it('defaults to the Agent pointer and preserves every explicit known pointer skin', () => {
    expect(sanitizeSettings({}, fallback).cursorSkin).toBe('agent')
    for (const skin of CURSOR_SKINS) {
      expect(sanitizeSettings({ cursorSkin: skin }, fallback).cursorSkin).toBe(skin)
    }
    // Someone who chose the hand keeps the hand.
    expect(sanitizeSettings({ cursorSkin: 'hand' }, fallback).cursorSkin).toBe('hand')
    expect(sanitizeSettings({ cursorSkin: 'sparkle' }, fallback).cursorSkin).toBe('agent')
  })
  it('moves the record panel\'s old pointer names to the pointer each was drawn as', () => {
    expect(sanitizeSettings({ cursorSkin: 'arrow-dark' }, fallback).cursorSkin).toBe('arrow')
    expect(sanitizeSettings({ cursorSkin: 'ring' }, fallback).cursorSkin).toBe('dot')
    expect(sanitizeSettings({ cursorSkin: 'crosshair' }, fallback).cursorSkin).toBe('arrow')
    expect(sanitizeSettings({ cursorSkin: 'hermes' }, fallback).cursorSkin).toBe('sprite')
  })
})

describe('defaultRecordingsRoot', () => {
  const videos = path.resolve('videos-home', 'ScreenPolish')

  it('is the ScreenPolish folder under Videos', () => {
    delete process.env.POLISH_RECORDINGS_ROOT
    expect(defaultRecordingsRoot()).toBe(videos)
  })

  it('honours POLISH_RECORDINGS_ROOT so a test run never records into the owner library', () => {
    const scratch = path.resolve('scratch-recordings')
    process.env.POLISH_RECORDINGS_ROOT = `${scratch}${path.sep}`
    try {
      expect(defaultRecordingsRoot()).toBe(path.normalize(`${scratch}${path.sep}`))
    } finally {
      delete process.env.POLISH_RECORDINGS_ROOT
    }
  })

  it('ignores a relative override', () => {
    process.env.POLISH_RECORDINGS_ROOT = 'somewhere/relative'
    try {
      expect(defaultRecordingsRoot()).toBe(videos)
    } finally {
      delete process.env.POLISH_RECORDINGS_ROOT
    }
  })
})
