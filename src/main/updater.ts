import type { UpdateState } from '@shared/ipc'

/**
 * Updates on Windows, from published releases.
 *
 * The packaged Windows app asks GitHub for the latest release when it starts
 * and every six hours, and downloads a newer one in the background. When it is
 * ready the editor offers "Restart to update"; if that is ignored, it is
 * installed the next time the app is closed. Restarting is refused while a
 * take is recording or an export is being written. Drafts and pre-releases
 * are never offered: only versions someone published.
 *
 * Linux installs are extracted bundles updated by the installer, and macOS
 * builds are unsigned, which macOS's updater will not accept; both are left
 * alone.
 */

export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000
export const FIRST_CHECK_AFTER_MS = 20_000

/** The part of electron-updater's autoUpdater this uses, so it can be stood in for in tests. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: 'update-available', fn: (info: { version: string }) => void): unknown
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown
  on(event: 'update-downloaded', fn: (info: { version: string }) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  updater: Updater
  /** True when nothing is recording or exporting, so the app may close. */
  canRestart: () => boolean
  /** Called whenever the state changes, to tell the editor. */
  onState: (state: UpdateState) => void
  log?: (message: string) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  setTimeout?: (fn: () => void, ms: number) => unknown
}

/** Whether this build updates itself: the packaged Windows app, unless switched off. */
export function updatesEnabled(platform: NodeJS.Platform, packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return platform === 'win32' && packaged && env.POLISH_NO_UPDATES !== '1'
}

export function startUpdater(deps: UpdaterDeps): { state: () => UpdateState; install: () => void; check: () => void } {
  const { updater } = deps
  let state: UpdateState = { status: 'idle' }
  const set = (next: UpdateState) => {
    state = next
    deps.onState(next)
  }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }))
  updater.on('download-progress', (p) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(p.percent) })
  })
  updater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }))
  // Being offline, or GitHub being slow, is not worth interrupting anyone over.
  updater.on('error', (err) => deps.log?.(`[updater] ${err.message}`))
  const check = () => {
    if (state.status === 'ready') return
    updater.checkForUpdates().catch((err: Error) => deps.log?.(`[updater] ${err.message}`))
  }
  ;(deps.setTimeout ?? setTimeout)(check, FIRST_CHECK_AFTER_MS)
  ;(deps.setInterval ?? setInterval)(check, UPDATE_CHECK_EVERY_MS)
  return {
    state: () => state,
    check,
    install: () => {
      if (state.status !== 'ready') throw new Error('No update is ready yet.')
      if (!deps.canRestart()) throw new Error('Finish the recording or export first; the update restarts ScreenPolish.')
      updater.quitAndInstall(true, true)
    }
  }
}
