// Polish main process bootstrap.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { BrowserWindow, Notification, app, dialog, globalShortcut, ipcMain, screen } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { EDITOR, type StartRecordingRequest } from '@shared/ipc'
import { startUpdater, updatesEnabled, type Updater } from './updater'
import { cliArgs, handleCliPayload, runCliClient } from './cli'
import { looksLikeCli } from './cli-parse'
import { isCursorHidden, recoverCursorsIfNeeded, restoreSystemCursor } from './win/cursor-manager'
import { defaultBackgroundsRoot, defaultMusicRoot, getCursorSkin, loadSettings } from './settings'
import { shortcutManager, shouldRegisterGlobalShortcuts } from './shortcuts'
import { DEFAULT_SHORTCUTS, shortcutLabel } from '@shared/shortcuts'
import { registerExportRequestIpc } from './export-requests'
import { replayBuffer } from './replay'
import { findGsr } from './linux/gsr'
import { acquireSingleInstanceLock, releaseServerSpawn } from './server-lock'
import { durationOf } from './duration'
import { createExportSink } from './export-sink'
import { registerEditorIpc } from './ipc'
import { whisperFiles } from './captions'
import { recordingsRoot, registerMediaProtocol, registerMediaScheme } from './media-protocol'
import { loadRecordDefaults, resolveDeviceChoice } from './record-defaults'
import { removeStateFile, writeStateFile } from './state-file'
import { preloadInputHook } from './input-logger'
import { recordingSession } from './recording-session'
import { runSelfTest, selfTestRequested } from './selftest'
import { writeThumbnail } from './thumbnail'
import { createTray, type TrayHandle } from './tray'
import { closeCamBubble, closeGhostCursor, closeHud, closeRegionFrame, getCamBubble, getEditorWindow, openCamBubble, openEditor, openGhostCursor, openHud, openRegionFrame, pickRegion, updateHud } from './windows'
import { canShowCaptureExcludedOverlays } from './capture-cursor'
import { TIMED_OUT, withTimeout } from './with-timeout'

registerMediaScheme()
app.setAppUserModelId('com.bikashjoshi.screenpolish')

// Wayland (Omarchy/Hyprland): screen capture goes through xdg-desktop-portal and
// PipeWire rather than X11, and Chromium only takes that route when the feature
// is enabled. `ozone-platform-hint=auto` keeps the windows themselves native
// Wayland instead of XWayland. Both must be set before the app is ready, and
// neither does anything on Windows or macOS.
if (process.platform === 'linux') {
  // The Wayland GPU path can fail to import PipeWire/decoded video buffers
  // (EGL_BAD_MATCH), producing green frames or stalled exports. Use the same
  // CPU-backed compositor for capture, preview and export on this platform.
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,GlobalShortcutsPortal')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

// The self-test gets its own userData so it never fights a running dev instance for the single-instance lock.
if (selfTestRequested()) app.setPath('userData', path.join(app.getPath('temp'), 'polish-selftest'))
// Dev builds keep their own userData (and therefore their own single-instance
// lock) so `npm run dev` never fights an installed Polish.
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'ScreenPolish-dev'))

// `Polish.exe <command>` is a CLI client: it never becomes the tray app itself.
// See cli.ts. Everything else is the server (single instance).
const argv = cliArgs()
const isCliClient = looksLikeCli(argv) && !selfTestRequested()
// A CLI client that is waiting for us polls by taking this same lock, so one
// refusal does not mean another server owns it. Quitting on the first refusal
// is what made a freshly spawned server vanish and the command time out.
const gotLock = isCliClient ? false : acquireSingleInstanceLock(() => app.requestSingleInstanceLock())
/** Where the CLI's replies and the watchable state file live. */
const cliDir = (): string => path.join(app.getPath('userData'), 'cli')
if (isCliClient) {
  void runCliClient(argv)
} else if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    void handleCliPayload(data, { session, durationOf })
  })
  // We are the server the client was waiting for; the next start need not wait.
  releaseServerSpawn(cliDir())
  app.whenReady().then(main).catch((err) => {
    console.error('[main] startup failed', err)
    dialog.showErrorBox('Polish failed to start', err instanceof Error ? err.stack ?? err.message : String(err))
    app.quit()
  })
}

function ffmpegPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (!ffmpegStatic) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')
  return ffmpegStatic
}

const session = recordingSession
session.systemAudioEncoder = ffmpegPath
let tray: TrayHandle | null = null
let hudPulse: NodeJS.Timeout | null = null
let quitting = false
/** Longest quitting waits for a recording to be written before going anyway. */
const QUIT_STOP_TIMEOUT_MS = 30_000
const CAN_SHOW_CAPTURE_OVERLAYS = canShowCaptureExcludedOverlays(process.platform)

// Hotkey and tray recordings use whatever the record panel last chose.
const defaultRequest = (source: StartRecordingRequest['source']): StartRecordingRequest => {
  const d = loadRecordDefaults()
  return {
    source,
    mic: resolveDeviceChoice(d.mic) ? { deviceId: resolveDeviceChoice(d.mic) as string } : null,
    system: d.system,
    webcam: resolveDeviceChoice(d.webcam) ? { deviceId: resolveDeviceChoice(d.webcam) as string } : null,
    fps: d.fps
  }
}

function reportError(title: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[main] ${title}:`, message)
  dialog.showErrorBox(title, message)
}

async function recordPrimaryScreen(): Promise<void> {
  if (session.state.status !== 'idle') return
  const display = screen.getPrimaryDisplay()
  await session.start(defaultRequest({ kind: 'screen', displayId: display.id }))
}

async function recordRegion(): Promise<void> {
  if (session.state.status !== 'idle') return
  session.beginPicking()
  let picked = null
  try {
    picked = await pickRegion()
  } finally {
    session.endPicking()
  }
  if (!picked) return
  await session.start(defaultRequest({ kind: 'region', displayId: picked.displayId, region: picked.region }))
}

/**
 * Save what the replay buffer holds, and say so. A notification rather than a
 * dialog: this is pressed mid-work, and the answer matters more than attention.
 */
async function saveReplayNow(): Promise<void> {
  if (!replayBuffer.running) {
    if (Notification.isSupported()) {
      new Notification({ title: 'ScreenPolish', body: 'No replay buffer is running. Start one from the tray.', silent: true }).show()
    }
    return
  }
  try {
    const { clip } = await replayBuffer.save()
    if (!Notification.isSupported()) return
    new Notification({
      title: 'ScreenPolish',
      body: clip ? `Saved ${path.basename(clip)}` : 'The replay was asked for but no clip appeared.',
      silent: true
    }).show()
  } catch (err) {
    reportError('Could not save the replay', err)
  }
}

/**
 * The replay buffer rides gpu-screen-recorder, so it exists on Linux with gsr
 * installed and nowhere else. Asked once: the answer does not change while the
 * app runs, and the tray asks every time it rebuilds its menu.
 */
const REPLAY_AVAILABLE = process.platform === 'linux' && findGsr() !== null

/** Seconds the tray's one-click buffer holds. Long enough to catch what just happened. */
const TRAY_REPLAY_SECONDS = 30

async function startReplayBuffer(): Promise<void> {
  try {
    await replayBuffer.start({
      root: recordingsRoot(),
      displayBounds: screen.getPrimaryDisplay().bounds,
      seconds: TRAY_REPLAY_SECONDS,
      fps: loadRecordDefaults().fps
    })
    if (Notification.isSupported()) {
      const keys = loadSettings().shortcuts ?? DEFAULT_SHORTCUTS
      new Notification({
        title: 'ScreenPolish',
        body: `Holding the last ${TRAY_REPLAY_SECONDS} seconds. Press ${shortcutLabel(keys.saveReplay)} to keep them.`,
        silent: true
      }).show()
    }
  } catch (err) {
    reportError('Could not start the replay buffer', err)
  }
}

function toggleRecording(): void {
  const status = session.state.status
  if (status === 'idle') recordPrimaryScreen().catch((err) => reportError('Could not start recording', err))
  else if (status === 'countdown' || status === 'recording') session.stop().catch((err) => reportError('Could not stop recording', err))
}

async function main(): Promise<void> {
  registerMediaProtocol()
  // Load the input hook once, up front, so starting a recording never waits on
  // a native module (and so a failure to load is reported at startup, not mid-take).
  await preloadInputHook()
  if (recoverCursorsIfNeeded()) console.warn('[main] restored system cursors left hidden by a previous run')

  session.registerCaptureIpc()
  ipcMain.on('polish:hud:stop', () => {
    if (session.isActive) session.stop().catch((err) => reportError('Could not stop recording', err))
  })
  ipcMain.on('polish:hud:toggle-pause', () => session.togglePause())
  registerExportRequestIpc()
  session.onFinished = (folder) => {
    // Thumbnail first so the library has it when the editor comes back; capped inside writeThumbnail.
    writeThumbnail(ffmpegPath(), folder).finally(() => openEditor(folder))
  }
  session.onError = (message) => dialog.showErrorBox('Recording problem', message)
  session.onWarning = (message) => {
    if (Notification.isSupported()) new Notification({ title: 'ScreenPolish', body: message, silent: true }).show()
  }

  const exportSink = createExportSink({
    root: recordingsRoot,
    ffmpegPath,
    onProgress: (_id, fraction) => tray?.setExportProgress(fraction)
  })

  // A development run leaves the desktop's recording hotkeys to the installed
  // app unless it asks for them; see shouldRegisterGlobalShortcuts.
  const ownsShortcuts = shouldRegisterGlobalShortcuts({ packaged: app.isPackaged })
  const shortcutRegistry = ownsShortcuts ? globalShortcut : { register: () => true, unregisterAll: () => undefined }
  if (!ownsShortcuts) console.log('[main] development run: recording hotkeys left to the installed app (POLISH_DEV_SHORTCUTS=1 to take them)')
  const applyShortcuts = shortcutManager(shortcutRegistry, {
    record: toggleRecording,
    pause: () => session.togglePause(),
    stop: () => { if (session.isActive) session.stop().catch((err) => reportError('Could not stop recording', err)) },
    // Only where the buffer can exist; elsewhere the key is left to other apps.
    ...(REPLAY_AVAILABLE ? { saveReplay: () => { void saveReplayNow() } } : {})
  })
  registerEditorIpc({ session, exportSink, root: recordingsRoot, musicRoot: defaultMusicRoot, backgroundsRoot: defaultBackgroundsRoot, getEditorWindow, durationOf, pickRegion, ffmpegPath,
    whisper: () => whisperFiles({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), platform: process.platform }),
    applyShortcuts: (keys) => { applyShortcuts(keys); setTimeout(() => tray?.update(session.state), 0) }
  })

  // Windows updates itself from published releases; elsewhere this stays idle.
  let update: ReturnType<typeof startUpdater> | null = null
  ipcMain.handle(EDITOR.updateState, () => update?.state() ?? { status: 'idle' })
  ipcMain.handle(EDITOR.installUpdate, () => {
    if (!update) throw new Error('This build does not update itself.')
    update.install()
  })
  if (updatesEnabled(process.platform, app.isPackaged, process.env)) {
    void import('electron-updater')
      .then(({ autoUpdater }) => {
        update = startUpdater({
          updater: autoUpdater as unknown as Updater,
          canRestart: () => session.state.status === 'idle' && !exportSink.busy(),
          onState: (state) => {
            for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EDITOR.updateChanged, state)
          },
          log: (message) => console.log(message)
        })
      })
      .catch((err) => console.warn('[updater] could not start', err))
  }

  // However the buffer changes - the tray, the shortcut, the CLI, an agent over
  // MCP, or gsr dying - the menu reflects it.
  replayBuffer.onChange = () => tray?.update(session.state)
  tray = createTray({
    recordScreen: () => recordPrimaryScreen().catch((err) => reportError('Could not start recording', err)),
    recordRegion: () => recordRegion().catch((err) => reportError('Could not start recording', err)),
    stop: () => session.stop().catch((err) => reportError('Could not stop recording', err)),
    togglePause: () => session.togglePause(),
    openLibrary: () => openEditor(''),
    startReplay: () => { void startReplayBuffer() },
    saveReplay: () => { void saveReplayNow() },
    stopReplay: () => { void replayBuffer.stop() },
    replayRunning: () => replayBuffer.running,
    replayAvailable: () => REPLAY_AVAILABLE,
    quit: () => app.quit()
  })

  writeStateFile(cliDir(), session.state, process.pid, session.lastFolder)
  session.onStateChange((state) => {
    writeStateFile(cliDir(), state, process.pid, session.lastFolder)
    tray?.update(state)
    // Keep the editor out of the shot; openEditor brings it back when the recording lands.
    if (state.status === 'countdown' || state.status === 'recording') {
      const win = getEditorWindow()
      if (win?.isVisible()) win.hide()
    }
    // Recording HUD (countdown, timer, stop) and the ghost cursor, both invisible to the capture.
    if (CAN_SHOW_CAPTURE_OVERLAYS && (state.status === 'countdown' || state.status === 'recording')) {
      const display = session.activeDisplay ?? screen.getPrimaryDisplay()
      openHud(display)
      updateHud(state)
      // Re-push once a second: the HUD page may still be loading when the first
      // state arrives, and the timer needs a heartbeat anyway.
      if (!hudPulse) hudPulse = setInterval(() => updateHud(session.state), 1000)
      if (state.status === 'recording') {
        // Only when we actually blanked the system cursors. In 'system' mode the
        // real pointer is still on screen and a second one would be confusing.
        if (isCursorHidden()) openGhostCursor(getCursorSkin())
        const r = session.activeRegion
        if (r?.isRegion && display) openRegionFrame(display, r.region)
      }
    } else {
      closeRegionFrame()
      if (hudPulse) {
        clearInterval(hudPulse)
        hudPulse = null
      }
      closeHud()
      closeGhostCursor()
    }
    // Live camera view while recording with a webcam; gone the moment it stops.
    if (CAN_SHOW_CAPTURE_OVERLAYS && state.status === 'recording' && !state.paused) {
      const cam = session.activeWebcam
      const display = session.activeDisplay
      if (cam && display && !getCamBubble()) {
        openCamBubble(display, cam)
        if (!app.isPackaged && process.env.POLISH_SHOT_BUBBLE) devShotBubble(process.env.POLISH_SHOT_BUBBLE)
        if (!app.isPackaged && process.env.POLISH_SHOT_HUD) devShotHud(process.env.POLISH_SHOT_HUD)
      }
    } else if (state.status !== 'recording') {
      closeCamBubble()
    }
  })

  try { applyShortcuts(loadSettings().shortcuts ?? DEFAULT_SHORTCUTS) }
  catch (error) { console.warn('[main] Global shortcuts unavailable:', error) }

  console.log(`[main] ready; recordings in ${recordingsRoot()}`)
  if (selfTestRequested()) {
    void runSelfTest(session)
    return
  }
  if (!app.isPackaged && process.env.POLISH_GHOST_PREVIEW) {
    void devShotGhost(process.env.POLISH_GHOST_PREVIEW, process.env.POLISH_GHOST_SKIN ?? getCursorSkin())
    return
  }
  if (process.env.POLISH_SERVER !== '1') openEditor(process.env.POLISH_OPEN ?? '')
  if (!app.isPackaged && process.env.POLISH_SHOT) devScreenshot(process.env.POLISH_SHOT)
}

// Dev-only: POLISH_GHOST_PREVIEW=<png> [POLISH_GHOST_SKIN=ring] opens the overlay
// pointer on its own, drives it to a known point, and captures it. Never touches
// the real system cursors, so it is safe to run while someone is using the machine.
async function devShotGhost(target: string, skin: string): Promise<void> {
  const { BrowserWindow } = await import('electron')
  openGhostCursor(skin)
  const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'ScreenPolish cursor')
  if (!win) {
    console.error('[shot] no ghost window')
    app.quit()
    return
  }
  await new Promise((r) => setTimeout(r, 1200))
  try {
    const move = "window.dispatchEvent(new MouseEvent('mousemove', { clientX: 240, clientY: 160 })); document.getElementById('ghost').style.transform"
    // Same code path a forwarded WM_MOUSEMOVE takes, so this proves the fast path.
    const fast = await win.webContents.executeJavaScript(move)
    // ... and after the local-move grace period the main-process poll takes over.
    await new Promise((r) => setTimeout(r, 400))
    const slow = await win.webContents.executeJavaScript("document.getElementById('ghost').style.transform")
    const shown = await win.webContents.executeJavaScript("document.querySelector('.skin.on')?.dataset.skin ?? 'none'")
    console.log(`[shot] ghost skin=${shown} fast=${fast} fallback=${slow}`)
    await win.webContents.executeJavaScript(move)
    const image = await win.webContents.capturePage({ x: 180, y: 100, width: 160, height: 140 })
    fs.writeFileSync(target, image.toPNG())
    console.log(`[shot] wrote ghost ${target} ${image.getSize().width}x${image.getSize().height}`)
  } catch (err) {
    console.error('[shot] ghost failed', err)
  }
  closeGhostCursor()
  app.quit()
}

// Dev-only: POLISH_SHOT_HUD=<png> captures the recording HUD 2.5 s into the recording.
function devShotHud(target: string): void {
  setTimeout(async () => {
    const { BrowserWindow } = await import('electron')
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'ScreenPolish recording')
    if (!win) return
    try {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(target, image.toPNG())
      console.log(`[shot] wrote hud ${target} ${image.getSize().width}x${image.getSize().height}`)
    } catch (err) {
      console.error('[shot] hud failed', err)
    }
  }, 2500)
}

// Dev-only: POLISH_SHOT_BUBBLE=<png> captures the camera bubble a moment after it opens.
function devShotBubble(target: string): void {
  setTimeout(async () => {
    const win = getCamBubble()
    if (!win) return
    try {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(target, image.toPNG())
      console.log(`[shot] wrote bubble ${target} ${image.getSize().width}x${image.getSize().height}`)
    } catch (err) {
      console.error('[shot] bubble failed', err)
    }
  }, 2500)
}

// Dev-only: `POLISH_SHOT=<png> [POLISH_OPEN=<folder>] npm run dev` captures the
// editor window to a PNG a few seconds after it loads, then exits. Lets an
// agent look at the UI without desktop automation.
function devScreenshot(target: string): void {
  const win = getEditorWindow()
  if (!win) return
  const waitForAutoexport = (process.env.POLISH_QUERY ?? '').includes('autoexport=')
  let done = false
  const finish = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      // POLISH_SHOT_JS runs in the page first (scroll a panel, open a sheet) so a shot can show what is below the fold.
      if (process.env.POLISH_SHOT_JS) {
        await win.webContents.executeJavaScript(process.env.POLISH_SHOT_JS, true)
        await new Promise((r) => setTimeout(r, 400))
      }
      const image = await win.webContents.capturePage()
      fs.writeFileSync(target, image.toPNG())
      console.log(`[shot] wrote ${target} ${image.getSize().width}x${image.getSize().height}`)
    } catch (err) {
      console.error('[shot] failed', err)
    }
    app.exit(0)
  }
  win.webContents.on('console-message', (event) => {
    console.log(`[editor:${event.level}] ${event.message}`)
    if (waitForAutoexport && event.message.startsWith('[autoexport]')) setTimeout(() => void finish(), 500)
  })
  const delay = Number(process.env.POLISH_SHOT_DELAY ?? (waitForAutoexport ? 180000 : 3000))
  win.webContents.once('did-finish-load', () => setTimeout(() => void finish(), delay))
}

app.on('window-all-closed', () => {
  // Tray app: closing the editor keeps Polish running.
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  if (session.isActive) {
    event.preventDefault()
    // Quitting waits for the recording to be written, but not forever: this
    // handler runs once, and a stop that never settles used to leave no way
    // out of the app but killing it.
    void withTimeout(
      session.stop().catch((err) => console.error('[main] stop on quit failed', err)),
      QUIT_STOP_TIMEOUT_MS
    ).then((settled) => {
      if (settled === TIMED_OUT) console.warn('[main] the recording did not finish in time; quitting anyway')
      restoreSystemCursor()
      app.quit()
    })
    return
  }
  restoreSystemCursor()
})

app.on('will-quit', () => {
  if (gotLock) removeStateFile(cliDir())
  globalShortcut.unregisterAll()
  restoreSystemCursor()
  tray?.destroy()
  tray = null
})
