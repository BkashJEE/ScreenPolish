import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { CAPTIONS_NOT_INSTALLED } from '../shared/captions'
import { captionsStatus, parseWhisperProgress, whisperArgs, whisperBinaryName, whisperFiles, whisperMissing, whisperThreads } from './captions'

describe('whisperFiles', () => {
  it('uses the packaged resources in a built app and vendor/ in a checkout', () => {
    expect(whisperFiles({ isPackaged: true, resourcesPath: '/opt/ScreenPolish/resources', appPath: '/x', platform: 'linux' })).toEqual({
      bin: path.join('/opt/ScreenPolish/resources', 'whisper', 'whisper-cli'),
      model: path.join('/opt/ScreenPolish/resources', 'whisper', 'ggml-base.en.bin'),
      packaged: true
    })
    expect(whisperFiles({ isPackaged: false, resourcesPath: '/x', appPath: '/repo', platform: 'linux' }).bin).toBe(path.join('/repo', 'vendor', 'whisper', 'whisper-cli'))
    expect(whisperFiles({ isPackaged: true, resourcesPath: 'C:\\app', appPath: '/x', platform: 'win32' }).bin.endsWith('whisper-cli.exe')).toBe(true)
  })

  it('names the Windows executable and the Unix binary, in the same resources/whisper directory', () => {
    expect(whisperBinaryName('win32')).toBe('whisper-cli.exe')
    expect(whisperBinaryName('darwin')).toBe('whisper-cli')
    expect(whisperBinaryName('linux')).toBe('whisper-cli')
    const win = whisperFiles({ isPackaged: true, resourcesPath: 'C:\\ScreenPolish\\resources', appPath: '/x', platform: 'win32' })
    expect(win.bin).toBe(path.join('C:\\ScreenPolish\\resources', 'whisper', 'whisper-cli.exe'))
    expect(win.model).toBe(path.join('C:\\ScreenPolish\\resources', 'whisper', 'ggml-base.en.bin'))
    const mac = whisperFiles({ isPackaged: true, resourcesPath: '/Applications/ScreenPolish.app/Contents/Resources', appPath: '/x', platform: 'darwin' })
    expect(mac.bin).toBe(path.join('/Applications/ScreenPolish.app/Contents/Resources', 'whisper', 'whisper-cli'))
    expect(mac.model).toBe(path.join('/Applications/ScreenPolish.app/Contents/Resources', 'whisper', 'ggml-base.en.bin'))
    expect(whisperFiles({ isPackaged: false, resourcesPath: '/x', appPath: '/repo', platform: 'win32' }).bin).toBe(path.join('/repo', 'vendor', 'whisper', 'whisper-cli.exe'))
    expect(whisperFiles({ isPackaged: false, resourcesPath: '/x', appPath: '/repo', platform: 'darwin' }).bin).toBe(path.join('/repo', 'vendor', 'whisper', 'whisper-cli'))
  })

  it('records whether the paths are a packaged build, which decides the missing-file wording', () => {
    expect(whisperFiles({ isPackaged: true, resourcesPath: '/r', appPath: '/x', platform: 'linux' }).packaged).toBe(true)
    expect(whisperFiles({ isPackaged: false, resourcesPath: '/r', appPath: '/x', platform: 'linux' }).packaged).toBe(false)
  })
})

describe('whisperMissing', () => {
  const files = { bin: '/w/whisper-cli', model: '/w/ggml-base.en.bin' }
  it('names the missing piece and how to get it', () => {
    expect(whisperMissing(files, () => false)).toMatch(/speech engine is missing.*fetch-whisper/)
    expect(whisperMissing(files, (p) => p === files.bin)).toMatch(/speech model is missing/)
    expect(whisperMissing(files, () => true)).toBeNull()
  })

  it('tells a user of an installed build that captions are not on it, without a rebuild instruction', () => {
    const packaged = { bin: 'C:\\P\\resources\\whisper\\whisper-cli.exe', model: 'C:\\P\\resources\\whisper\\ggml-base.en.bin', packaged: true }
    const noEngine = whisperMissing(packaged, (p) => p === packaged.model)
    expect(noEngine).toContain(CAPTIONS_NOT_INSTALLED)
    expect(noEngine).toMatch(/speech engine/)
    expect(noEngine).not.toMatch(/fetch-whisper/)
    expect(whisperMissing(packaged, (p) => p === packaged.bin)).toMatch(/speech model/)
    expect(whisperMissing(packaged, () => true)).toBeNull()
  })
})

describe('captionsStatus', () => {
  const files = { bin: '/w/whisper-cli', model: '/w/ggml-base.en.bin', packaged: true }
  it('is installed only when both files exist, and carries the reason otherwise', () => {
    expect(captionsStatus(files, () => true)).toEqual({ installed: true, reason: null })
    const missing = captionsStatus(files, () => false)
    expect(missing.installed).toBe(false)
    expect(missing.reason).toContain(CAPTIONS_NOT_INSTALLED)
    expect(captionsStatus(files, (p) => p === files.bin).reason).toMatch(/speech model/)
  })
})

describe('whisperArgs', () => {
  it('asks for English JSON, caption-length lines split on words, and progress', () => {
    const args = whisperArgs({ bin: 'b', model: 'm.bin' }, 'a.wav', '/tmp/out', 6)
    expect(args).toEqual(expect.arrayContaining(['-m', 'm.bin', '-f', 'a.wav', '-t', '6', '-l', 'en', '-ojf', '-of', '/tmp/out', '-ml', '42', '-sow', '-pp', '-np']))
  })
})

describe('parseWhisperProgress', () => {
  it('reads the percentage from whisper-cli progress lines', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  45%')).toBe(45)
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 100%')).toBe(100)
    expect(parseWhisperProgress('whisper_init_from_file_with_params_no_state: loading model')).toBeNull()
  })
})

describe('whisperThreads', () => {
  it('leaves two cores free and stops at eight', () => {
    expect(whisperThreads(28)).toBe(8)
    expect(whisperThreads(6)).toBe(4)
    expect(whisperThreads(2)).toBe(1)
  })
})
