// Every EDITOR.* handler. Filesystem access is confined to the recordings root.

import * as fs from 'node:fs'
import { askAgent, availableAgents, loadUserAgents } from './plan-agents'
import { extractPlan, normalizeTakeLook, planPrompt, type PlanContext, type PlanTurn } from '@shared/record-plan'
import * as path from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import {
  EDITOR,
  type AppSettings,
  type ExportBeginRequest,
  type ExportEndRequest,
  type LoadedProject,
  type SaveImageRequest,
  type SetCoverRequest,
  type StartRecordingRequest
} from '@shared/ipc'
import type { CaptureRegion, Project, RecordingEvents, RecordingFiles, RecordingSummary } from '@shared/types'
import { assertInsideRoot, type ExportSink } from './export-sink'
import { copyFileToClipboard } from './clipboard-file'
import { allowImage, mediaUrl } from './media-protocol'
import { ensureShelf, listTracks } from './music-library'
import { ensureBackgroundsFolder, listBackgrounds } from './background-library'
import { IMPORT_EXTENSIONS, importVideo } from './import-video'
import { deleteLookIn, loadShelf, saveLookIn, setDefaultLookIn } from './looks'
import { CLEAN_MIC_FILE, cleanMic } from './voice-cleanup'
import { writeThumbnail } from './thumbnail'
import { isRecordingFolderName, parseFolderName, sanitizeBaseName, uniqueName } from './naming'
import { saveVoiceover, voiceoverFile } from './voiceover'
import { mergeProject, serializeProject } from './project-io'
import { saveRecordDefaults } from './record-defaults'
import { getDefaultLook, loadSettings, saveSettings, setRecordingsRoot } from './settings'
import type { RecordingSession } from './recording-session'
import { listSources, listsThroughPortal, windowPreviews } from './sources'
import { findGsr } from './linux/gsr'
import { THUMB_RELATIVE } from './thumbnail'
import { cursorBakedForPlayback } from './capture-cursor'
import { captionsStatus, transcribe, type WhisperFiles } from './captions'
import { validateShortcuts, type RecordingShortcuts } from '@shared/shortcuts'


export interface EditorIpcDeps {
  applyShortcuts?: (shortcuts: RecordingShortcuts) => void
  session: RecordingSession
  exportSink: ExportSink
  root: () => string
  /** Where the music shelf lives; a folder the user can drop tracks into. */
  musicRoot: () => string
  backgroundsRoot: () => string
  getEditorWindow: () => BrowserWindow | null

  durationOf: (file: string) => Promise<number | null>
  /** Bundled ffmpeg and whisper, for captions. */
  ffmpegPath: () => string
  whisper: () => WhisperFiles
  /** Region overlay across every display; resolves null when the user cancels. */
  pickRegion: () => Promise<{ region: CaptureRegion; displayId: number } | null>
}

const OPTIONAL_FILES = [
  ['mic', 'mic.mp4'],
  ['micClean', CLEAN_MIC_FILE],
  ['system', 'system.mp4'],
  ['webcam', 'webcam.mp4']
] as const

const exists = (p: string): boolean => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** Allow-list every user image the project references so polish://image/ can serve it. */
function allowProjectImages(project: Project): void {
  if (project.background.imagePath && !project.background.imagePath.startsWith('bundled:')) allowImage(project.background.imagePath)
  for (const o of project.overlays ?? []) if (o.kind === 'image' && typeof o.content === 'string' && o.content) allowImage(o.content)
  for (const audio of project.audioRegions ?? []) if (typeof audio.path === 'string') allowImage(audio.path)
}

/** Bytes from the renderer arrive as an ArrayBuffer or a typed array view; either way we want a Buffer. */
function toBuffer(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  throw new Error('Image data must be an ArrayBuffer')
}

export async function loadProject(root: string, folder: string): Promise<LoadedProject> {
  const dir = assertInsideRoot(root, folder)
  const files: RecordingFiles = {
    folder: dir,
    screen: path.join(dir, 'screen.mp4'),
    events: path.join(dir, 'events.json'),
    project: path.join(dir, 'project.json')
  }
  if (!exists(files.screen)) throw new Error(`No screen.mp4 in ${dir}`)
  if (!exists(files.events)) throw new Error(`No events.json in ${dir}`)
  const events = JSON.parse(await fs.promises.readFile(files.events, 'utf8')) as RecordingEvents
  // Older Linux versions incorrectly said the portal stream contained a
  // cursor. Correct it in memory so existing recordings gain the ghost cursor
  // without modifying their source metadata on disk.
  events.cursorBaked = cursorBakedForPlayback(process.platform, events.cursorBaked, events.cursorMode)
  let project: Project = mergeProject(null)
  if (exists(files.project)) {
    try {
      project = mergeProject(JSON.parse(await fs.promises.readFile(files.project, 'utf8')))
    } catch (err) {
      console.warn('[ipc] project.json unreadable, using defaults', err)
    }
  }
  allowProjectImages(project)

  const urls: LoadedProject['urls'] = { screen: mediaUrl(dir, 'screen.mp4') }
  for (const [key, name] of OPTIONAL_FILES) {
    const p = path.join(dir, name)
    if (exists(p)) {
      files[key] = p
      urls[key] = mediaUrl(dir, name)
    }
  }
  return { files, events, project, urls }
}

/** Recursive byte total; files vanishing during a concurrent export are skipped. */
export async function folderSize(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += await folderSize(p)
    else {
      try {
        total += (await fs.promises.stat(p)).size
      } catch {
        // vanished mid-listing
      }
    }
  }
  return total
}

/** Below this a screen.mp4 holds no playable frame. */
export const MIN_PREVIEW_BYTES = 1024

export async function listRecordings(root: string, durationOf: EditorIpcDeps['durationOf']): Promise<RecordingSummary[]> {
  if (!exists(root)) return []
  const entries = await fs.promises.readdir(root, { withFileTypes: true })
  const folders = entries
    .filter((e) => e.isDirectory() && isRecordingFolderName(e.name))
    .map((e) => ({ name: e.name, folder: path.join(root, e.name), createdAt: parseFolderName(e.name) ?? 0 }))
    .filter((f) => exists(path.join(f.folder, 'screen.mp4')))
    .sort((a, b) => b.createdAt - a.createdAt)

  return Promise.all(
    folders.map(async (f) => {
      const thumb = path.join(f.folder, 'exports', 'thumb.jpg')
      const summary: RecordingSummary = {
        folder: f.folder,
        name: f.name,
        createdAt: f.createdAt,
        durationSec: await durationOf(path.join(f.folder, 'screen.mp4'))
      }
      if (exists(thumb)) summary.thumbnail = mediaUrl(f.folder, 'exports/thumb.jpg')
      // A take that never received a frame is a bare MP4 header; nothing to preview.
      const screenBytes = await fs.promises.stat(path.join(f.folder, 'screen.mp4')).then((st) => st.size, () => 0)
      if (screenBytes >= MIN_PREVIEW_BYTES) summary.preview = mediaUrl(f.folder, 'screen.mp4')
      try {
        const project = mergeProject(JSON.parse(await fs.promises.readFile(path.join(f.folder, 'project.json'), 'utf8')))
        if (project.title) summary.title = project.title
      } catch {
        // no project.json yet, or unreadable: the folder name is the title
      }
      summary.sizeBytes = await folderSize(f.folder)
      return summary
    })
  )
}

export function registerEditorIpc(deps: EditorIpcDeps): void {
  const { session, exportSink } = deps

  ipcMain.handle(EDITOR.load, (_e, folder: string) => loadProject(deps.root(), folder))

  ipcMain.handle(EDITOR.save, async (_e, folder: string, project: Project) => {
    const dir = assertInsideRoot(deps.root(), folder)
    const merged = mergeProject(project)
    allowProjectImages(merged)
    const target = path.join(dir, 'project.json')
    const tmp = `${target}.tmp`
    await fs.promises.writeFile(tmp, serializeProject(merged))
    await fs.promises.rename(tmp, target)
  })

  ipcMain.handle(EDITOR.list, () => listRecordings(deps.root(), deps.durationOf))

  ipcMain.handle(EDITOR.reveal, (_e, target: string) => {
    assertInsideRoot(deps.root(), target)
    shell.showItemInFolder(target)
  })

  // Linux has no share sheet, so an export is handed on by clipboard or drag.
  // Both carry a text/uri-list, which is what a chat window or an upload box
  // reads; the plain text is the path, for a terminal.
  ipcMain.handle(EDITOR.copyFile, (_e, target: string) => {
    assertInsideRoot(deps.root(), target)
    copyFileToClipboard(target)
  })

  ipcMain.handle(EDITOR.openFile, async (_e, target: string) => {
    assertInsideRoot(deps.root(), target)
    const failure = await shell.openPath(target)
    if (failure) throw new Error(failure)
  })

  // startDrag must run inside the renderer's dragstart, so this is a send and
  // not an invoke: awaiting a round trip would let the gesture end first.
  ipcMain.on(EDITOR.dragFile, (event, target: string) => {
    assertInsideRoot(deps.root(), target)
    const thumb = path.join(path.dirname(target), 'thumb.jpg')
    const icon = fs.existsSync(thumb) ? nativeImage.createFromPath(thumb).resize({ height: 96 }) : nativeImage.createEmpty()
    event.sender.startDrag({ file: target, icon })
  })

  ipcMain.handle(EDITOR.openExternal, async (_e, url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error(`Refusing to open ${url}`)
    await shell.openExternal(url)
  })

  ipcMain.handle(EDITOR.deleteRecording, async (_e, folder: string) => {
    const dir = assertInsideRoot(deps.root(), folder)
    if (session.isActive && session.lastFolder === dir) throw new Error('That recording is still in progress')
    await shell.trashItem(dir)
  })

  ipcMain.handle(EDITOR.exportBegin, (_e, request: ExportBeginRequest) => exportSink.begin(request))
  ipcMain.handle(EDITOR.captionsStatus, () => captionsStatus(deps.whisper()))

  // Recording plans. The renderer names an agent by id; the command comes
  // only from the built-ins or plan-agents.json, which nothing here writes.
  const planAgentList = () => availableAgents(loadUserAgents(app.getPath('userData')))
  ipcMain.handle(EDITOR.planAgents, () => planAgentList().map(({ id, name }) => ({ id, name })))
  ipcMain.handle(EDITOR.askPlan, async (_e, agentId: string, context: PlanContext, history: PlanTurn[]) => {
    const agent = planAgentList().find((a) => a.id === agentId)
    if (!agent) throw new Error('That agent is not available on this machine.')
    const turns = (Array.isArray(history) ? history : [])
      .filter((t) => t && (t.role === 'user' || t.role === 'agent') && typeof t.text === 'string')
      .map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }))
      .slice(-12)
    if (!turns.some((t) => t.role === 'user')) throw new Error('Say what you want to record first.')
    const ctx: PlanContext = {
      screens: (Array.isArray(context?.screens) ? context.screens : []).slice(0, 8).map((sc) => ({ name: String(sc.name).slice(0, 120), width: Number(sc.width) || 0, height: Number(sc.height) || 0 })),
      windows: (Array.isArray(context?.windows) ? context.windows : []).slice(0, 30).map((w) => String(w).slice(0, 120)),
      hasMic: context?.hasMic === true,
      hasWebcam: context?.hasWebcam === true
    }
    return extractPlan(await askAgent(agent, planPrompt(ctx, turns)))
  })
  ipcMain.handle(EDITOR.setNextTakeLook, (_e, look: unknown) => {
    session.nextTakeLook = look === null ? null : normalizeTakeLook(look)
  })
  ipcMain.handle(EDITOR.transcribe, async (event, folder: string, source: 'mic' | 'system') => {
    const inside = assertInsideRoot(deps.root(), folder)
    if (source !== 'mic' && source !== 'system') throw new Error(`Unknown audio source: ${String(source)}`)
    return transcribe({
      audioFile: path.join(inside, `${source}.mp4`),
      ffmpeg: deps.ffmpegPath(),
      whisper: deps.whisper(),
      onProgress: (fraction) => {
        if (!event.sender.isDestroyed()) event.sender.send(EDITOR.transcribeProgress, fraction)
      }
    })
  })
  // Voiceover: save what the editor recorded beside the take, and transcribe it for captions.
  ipcMain.handle(EDITOR.saveVoiceover, (_e, folder: string, data: ArrayBuffer) =>
    saveVoiceover(deps.ffmpegPath(), assertInsideRoot(deps.root(), String(folder)), new Uint8Array(data))
  )
  ipcMain.handle(EDITOR.transcribeVoiceover, (event, folder: string, file: string) =>
    transcribe({
      audioFile: voiceoverFile(assertInsideRoot(deps.root(), String(folder)), String(file)),
      ffmpeg: deps.ffmpegPath(),
      whisper: deps.whisper(),
      onProgress: (fraction) => {
        if (!event.sender.isDestroyed()) event.sender.send(EDITOR.transcribeProgress, fraction)
      }
    })
  )
  ipcMain.handle(EDITOR.exportChunk, (_e, exportId: string, position: number, data: ArrayBuffer) => {
    exportSink.chunk(exportId, position, data)
  })
  ipcMain.handle(EDITOR.exportEnd, (_e, request: ExportEndRequest) => exportSink.end(request))
  ipcMain.handle(EDITOR.exportAbort, (_e, exportId: string) => exportSink.abort(exportId))
  ipcMain.on(EDITOR.exportProgress, (_e, exportId: string, fraction: number) => exportSink.progress(exportId, fraction))

  ipcMain.handle(EDITOR.pickImage, async (event: IpcMainInvokeEvent) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? deps.getEditorWindow() ?? undefined
    const result = await dialog.showOpenDialog(parent as BrowserWindow, {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (picked) allowImage(picked)
    return picked
  })

  ipcMain.handle(EDITOR.pickAudio, async (event: IpcMainInvokeEvent) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? deps.getEditorWindow() ?? undefined
    const result = await dialog.showOpenDialog(parent as BrowserWindow, {
      title: 'Choose music or voiceover', properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }]
    })
    const picked = result.canceled ? null : result.filePaths[0] ?? null
    if (picked) allowImage(picked)
    return picked
  })

  // The music shelf: a plain folder the editor reads. Listing a track also
  // clears it for the media protocol, which is how the renderer plays it — the
  // same gate a file chosen through the dialog goes through.
  ipcMain.handle(EDITOR.listMusic, () => {
    const tracks = listTracks(ensureShelf(deps.musicRoot()))
    for (const track of tracks) allowImage(track.path)
    return tracks
  })

  ipcMain.handle(EDITOR.openMusicFolder, async () => {
    const failure = await shell.openPath(ensureShelf(deps.musicRoot()))
    if (failure) throw new Error(failure)
  })

  // Listing the folder does not create it: only opening it does, so the app
  // never leaves an empty folder in Pictures for someone who never asked.
  // The recording guide: where it is, and its Next and Back buttons.
  ipcMain.handle(EDITOR.guideState, () => session.guideView)
  ipcMain.handle(EDITOR.guideMove, (_e, move: unknown) => {
    if (move === 'next' || move === 'back') session.moveGuide(move)
  })
  session.onGuideChange((view) => {
    const win = deps.getEditorWindow()
    if (win && !win.isDestroyed()) win.webContents.send(EDITOR.guideChanged, view)
  })

  ipcMain.handle(EDITOR.importVideo, async (event: IpcMainInvokeEvent) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? deps.getEditorWindow() ?? undefined
    const result = await dialog.showOpenDialog(parent as BrowserWindow, {
      title: 'Open a video',
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: [...IMPORT_EXTENSIONS] }]
    })
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (!picked) return null
    const folder = await importVideo(deps.ffmpegPath(), deps.root(), picked, getDefaultLook())
    await writeThumbnail(deps.ffmpegPath(), folder).catch(() => null)
    return folder
  })

  ipcMain.handle(EDITOR.listBackgrounds, () => {
    const images = listBackgrounds(deps.backgroundsRoot())
    for (const image of images) allowImage(image.path)
    return images
  })

  ipcMain.handle(EDITOR.openBackgroundsFolder, async () => {
    const failure = await shell.openPath(ensureBackgroundsFolder(deps.backgroundsRoot()))
    if (failure) throw new Error(failure)
  })

  // Thumbnail maker: a rendered still into <folder>/exports/<name>.<png|jpg>.
  ipcMain.handle(EDITOR.saveImage, async (_e, request: SaveImageRequest) => {
    const dir = assertInsideRoot(deps.root(), request.folder)
    if (request.format !== 'png' && request.format !== 'jpg') throw new Error(`Unsupported image format ${String(request.format)}`)
    const buf = toBuffer(request.data)
    if (buf.length === 0) throw new Error('Image is empty')
    const exportsDir = path.join(dir, 'exports')
    await fs.promises.mkdir(exportsDir, { recursive: true })
    const existing = await fs.promises.readdir(exportsDir)
    const target = path.join(exportsDir, uniqueName(existing, sanitizeBaseName(request.name), request.format))
    await fs.promises.writeFile(target, buf)
    return { path: target }
  })

  ipcMain.handle(EDITOR.cleanMic, async (_e, folder: string) => {
    const dir = assertInsideRoot(deps.root(), folder)
    await cleanMic(deps.ffmpegPath(), dir)
    return mediaUrl(dir, CLEAN_MIC_FILE)
  })

  ipcMain.handle(EDITOR.listLooks, () => loadShelf(app.getPath('userData')))
  ipcMain.handle(EDITOR.saveLook, (_e, name: string, look: import('@shared/presets').Look) => saveLookIn(app.getPath('userData'), String(name ?? ''), look))
  ipcMain.handle(EDITOR.deleteLook, (_e, id: string) => deleteLookIn(app.getPath('userData'), String(id)))
  ipcMain.handle(EDITOR.setDefaultLook, (_e, id: string | null) => setDefaultLookIn(app.getPath('userData'), id ? String(id) : null))

  ipcMain.handle(EDITOR.saveCaptions, async (_e, folder: string, name: string, text: string) => {
    const dir = assertInsideRoot(deps.root(), folder)
    if (typeof text !== 'string' || !text.trim()) throw new Error('There are no captions to save.')
    const exportsDir = path.join(dir, 'exports')
    await fs.promises.mkdir(exportsDir, { recursive: true })
    const target = path.join(exportsDir, uniqueName(await fs.promises.readdir(exportsDir), sanitizeBaseName(name), 'srt'))
    await fs.promises.writeFile(target, text)
    return target
  })

  // Library cover: <folder>/exports/thumb.jpg, which listRecordings already picks up.
  ipcMain.handle(EDITOR.setCover, async (_e, request: SetCoverRequest) => {
    const dir = assertInsideRoot(deps.root(), request.folder)
    const buf = toBuffer(request.data)
    if (buf.length === 0) throw new Error('Image is empty')
    const target = path.join(dir, THUMB_RELATIVE)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await fs.promises.writeFile(tmp, buf)
    await fs.promises.rename(tmp, target)
    return { path: target }
  })

  ipcMain.handle(EDITOR.startRecording, async (_e, request: StartRecordingRequest) => {
    const src = request.source
    // The record panel asks for the picker by sending a zero-size region. Nothing
    // used to honour that, so choosing Region and pressing Record recorded a 0x0
    // crop and never showed the overlay.
    if (src.kind === 'region' && (src.region.width <= 0 || src.region.height <= 0)) {
      deps.session.beginPicking()
      let picked: Awaited<ReturnType<typeof deps.pickRegion>> = null
      try {
        picked = await deps.pickRegion()
      } finally {
        deps.session.endPicking()
      }
      if (!picked) return
      return session.start({ ...request, source: { kind: 'region', displayId: picked.displayId, region: picked.region } })
    }
    return session.start(request)
  })
  ipcMain.handle(EDITOR.stopRecording, () => session.stop())
  ipcMain.handle(EDITOR.recordingState, () => session.state)
  ipcMain.handle(EDITOR.listSources, () => listSources())
  ipcMain.handle(EDITOR.captureCapabilities, () => ({
    cursorFree: process.platform === 'linux' && listsThroughPortal() && findGsr() !== null
  }))
  ipcMain.handle(EDITOR.windowPreviews, (_event, ids: unknown) =>
    windowPreviews(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 64) : [])
  )
  ipcMain.handle(EDITOR.listAudioDevices, () => [])
  ipcMain.on(EDITOR.saveRecordDefaults, (_e, defaults: unknown) => saveRecordDefaults(defaults))

  ipcMain.handle(EDITOR.getSettings, () => loadSettings())
  ipcMain.handle(EDITOR.saveSettings, (_event: IpcMainInvokeEvent, patch: Partial<AppSettings>) => {
    if (patch?.shortcuts) {
      if (deps.session.isActive) throw new Error('Finish the recording before changing global shortcuts')
      deps.applyShortcuts?.(validateShortcuts(patch.shortcuts))
    }
    return saveSettings(patch ?? {})
  })
  ipcMain.handle(EDITOR.chooseRecordingsRoot, async (event: IpcMainInvokeEvent) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? deps.getEditorWindow() ?? undefined
    const result = await dialog.showOpenDialog(parent as BrowserWindow, {
      title: 'Choose where recordings are saved',
      defaultPath: deps.root(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (!picked) return null
    return setRecordingsRoot(picked)
  })
  ipcMain.handle(EDITOR.openRecordingsRoot, async () => {
    await shell.openPath(deps.root())
  })
  session.onStateChange((state) => {
    const win = deps.getEditorWindow()
    if (win && !win.webContents.isDestroyed()) win.webContents.send(EDITOR.recordingStateChanged, state)
  })
}
