import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/ipc'
import { FIRST_CHECK_AFTER_MS, UPDATE_CHECK_EVERY_MS, startUpdater, updatesEnabled, type Updater } from './updater'

function fakeUpdater() {
  const handlers: Record<string, (arg: never) => void> = {}
  const u = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: true,
    on: (event: string, fn: (arg: never) => void) => { handlers[event] = fn },
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    emit: (event: string, arg: unknown) => handlers[event]!(arg as never)
  }
  return u as typeof u & Updater
}

function start(canRestart = () => true) {
  const updater = fakeUpdater()
  const states: UpdateState[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const handle = startUpdater({
    updater,
    canRestart,
    onState: (s) => states.push(s),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval: (fn, ms) => timers.push({ fn, ms })
  })
  return { updater, states, timers, handle }
}

describe('updatesEnabled', () => {
  it('is only the packaged Windows app, and can be switched off', () => {
    expect(updatesEnabled('win32', true, {})).toBe(true)
    expect(updatesEnabled('win32', false, {})).toBe(false)
    expect(updatesEnabled('linux', true, {})).toBe(false)
    expect(updatesEnabled('darwin', true, {})).toBe(false)
    expect(updatesEnabled('win32', true, { POLISH_NO_UPDATES: '1' })).toBe(false)
  })
})

describe('startUpdater', () => {
  it('downloads published releases on its own, never pre-releases or older versions', () => {
    const { updater, timers } = start()
    expect(updater).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false })
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_AFTER_MS, UPDATE_CHECK_EVERY_MS])
    timers[0]!.fn()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('reports downloading and ready, and stops checking once ready', () => {
    const { updater, states, timers, handle } = start()
    updater.emit('update-available', { version: '0.4.5' })
    updater.emit('download-progress', { percent: 41.6 })
    updater.emit('update-downloaded', { version: '0.4.5' })
    expect(states).toEqual([
      { status: 'downloading', version: '0.4.5', percent: 0 },
      { status: 'downloading', version: '0.4.5', percent: 42 },
      { status: 'ready', version: '0.4.5' }
    ])
    expect(handle.state()).toEqual({ status: 'ready', version: '0.4.5' })
    timers[1]!.fn()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('restarts into the update only when nothing is recording or exporting', () => {
    let idle = false
    const { updater, handle } = start(() => idle)
    expect(() => handle.install()).toThrow('No update is ready')
    updater.emit('update-downloaded', { version: '0.4.5' })
    expect(() => handle.install()).toThrow('Finish the recording or export first')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    idle = true
    handle.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('keeps quiet about errors, which are only logged', () => {
    const { updater, states } = start()
    updater.emit('error', new Error('offline'))
    expect(states).toEqual([])
  })
})
