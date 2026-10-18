// DEV-ONLY mock of window.polish so the editor page can be opened in a plain
// browser (http://localhost:<port>/editor/index.html?mock=1) for visual QA
// without the Electron main process. Never bundled for production: main.tsx
// only imports this module when import.meta.env.DEV and ?mock is present.

import type { EditorBridge, LoadedProject, RecordingState, SourceInfo } from '../shared/ipc'
import { DEFAULT_PROJECT, type RecordingEvents, type RecordingSummary } from '../shared/types'

const FOLDER = 'C:\\Users\\demo\\Videos\\Polish\\2026-09-01_20-00-00'
const CLIP_SECONDS = 4
const W = 1280
const H = 720

function fakeEvents(): RecordingEvents {
  const pointer: RecordingEvents['pointer'] = []
  for (let t = 0; t <= CLIP_SECONDS * 1000; t += 16) {
    const p = t / 1000
    pointer.push([t, Math.round(W * (0.5 + 0.38 * Math.sin(p * 1.3))), Math.round(H * (0.5 + 0.32 * Math.cos(p * 0.9)))])
  }
  const at = (ms: number) => pointer.reduce((best, s) => (Math.abs(s[0] - ms) < Math.abs(best[0] - ms) ? s : best))
  const clicks: RecordingEvents['clicks'] = []
  for (const ms of [900, 1250, 2600, 3300]) {
    const [, x, y] = at(ms)
    clicks.push({ t: ms, x, y, button: 'left', down: true }, { t: ms + 80, x, y, button: 'left', down: false })
  }
  return { version: 1, startedAt: Date.now() - CLIP_SECONDS * 1000, region: { x: 0, y: 0, width: W, height: H, scale: 1 }, pointer, clicks, wheel: [], keys: [] }
}

/** Record a few seconds of an animated canvas to a WebM blob URL. */
async function fakeClip(): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream(30)
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise<void>((r) => (rec.onstop = () => r()))
  const t0 = performance.now()
  let raf = 0
  const draw = () => {
    const t = (performance.now() - t0) / 1000
    ctx.fillStyle = '#1e2430'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#2b3342'
    ctx.fillRect(0, 0, W, 56)
    for (let i = 0; i < 8; i += 1) {
      ctx.fillStyle = i % 2 ? '#2f3848' : '#28303e'
      ctx.fillRect(40, 90 + i * 70, W - 80, 56)
      ctx.fillStyle = '#9aa3b5'
      ctx.font = '22px sans-serif'
      ctx.fillText(`Row ${i + 1}  lorem ipsum dolor sit amet`, 60, 126 + i * 70)
    }
    ctx.fillStyle = '#7c8cff'
    ctx.beginPath()
    ctx.arc(W * (0.5 + 0.38 * Math.sin(t * 1.3)), H * (0.5 + 0.32 * Math.cos(t * 0.9)), 18, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 28px sans-serif'
    ctx.fillText(`t = ${t.toFixed(2)} s`, 24, 40)
    raf = requestAnimationFrame(draw)
  }
  draw()
  rec.start(250)
  await new Promise((r) => setTimeout(r, CLIP_SECONDS * 1000))
  rec.stop()
  await done
  cancelAnimationFrame(raf)
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
}

export async function installMockBridge(): Promise<void> {
  const clipUrl = await fakeClip()
  const events = fakeEvents()
  let project = structuredClone(DEFAULT_PROJECT)
  let state: RecordingState = { status: 'idle' }
  const stateHandlers = new Set<(s: RecordingState) => void>()
  const openHandlers = new Set<(folder: string) => void>()
  const setState = (s: RecordingState) => {
    state = s
    stateHandlers.forEach((h) => h(s))
  }
  const recordings: RecordingSummary[] = [
    { folder: FOLDER, name: '2026-09-01_20-00-00', createdAt: Date.now() - 3600e3, durationSec: CLIP_SECONDS, preview: clipUrl },
    { folder: `${FOLDER}-b`, name: '2026-09-01_18-12-40', createdAt: Date.now() - 7200e3, durationSec: 83, preview: clipUrl },
    { folder: `${FOLDER}-c`, name: '2026-08-30_09-01-12', createdAt: Date.now() - 2 * 86400e3, durationSec: 612 }
  ]
  const sources: SourceInfo[] = [
    { id: '1', displayId: 1, name: 'Primary display (2560×1440)', kind: 'screen', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
    { id: '2', displayId: 2, name: 'Display 2 (1920×1080)', kind: 'screen', bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 'window:100:0', name: 'Visual Studio Code', kind: 'window' },
    { id: 'window:101:0', name: 'Google Chrome', kind: 'window' }
  ]
  const loaded = (folder: string): LoadedProject => ({
    files: { folder, screen: `${folder}\\screen.mp4`, events: `${folder}\\events.json`, project: `${folder}\\project.json` },
    events,
    project,
    urls: { screen: clipUrl }
  })

  const bridge: EditorBridge = {
    onOpen: (h) => {
      openHandlers.add(h)
      return () => openHandlers.delete(h)
    },
    load: async (folder) => loaded(folder),
    save: async (_f, p) => {
      project = p
    },
    list: async () => recordings,
    reveal: async (p) => console.info('[mock] reveal', p),
    copyFile: async (p) => console.info('[mock] copyFile', p),
    openFile: async (p) => console.info('[mock] openFile', p),
    dragFile: (p) => console.info('[mock] dragFile', p),
    openExternal: async (u) => console.info('[mock] openExternal', u),
    deleteRecording: async (folder) => {
      const i = recordings.findIndex((r) => r.folder === folder)
      if (i >= 0) recordings.splice(i, 1)
    },
    exportBegin: async (req) => ({ exportId: 'mock-1', path: `${req.folder}\\exports\\${req.name}.${req.kind}` }),
    exportChunk: async () => undefined,
    exportEnd: async () => ({ path: `${FOLDER}\\exports\\demo.mp4` }),
    exportAbort: async () => undefined,
    exportProgress: () => undefined,
    onExportRequest: () => () => undefined,
    pendingExport: async () => null,
    exportRequestDone: (r) => console.info('[mock] exportRequestDone', r),
    saveRecordDefaults: () => undefined,
    getSettings: async () => ({ recordingsRoot: 'C:\\Users\\mock\\Videos\\ScreenPolish', cursorMode: 'overlay' as const, cursorSkin: 'hand' as const }),
    saveSettings: async (patch) => ({ ...{ recordingsRoot: 'C:\\Users\\mock\\Videos\\ScreenPolish', cursorMode: 'overlay' as const, cursorSkin: 'hand' as const }, ...patch }),
    chooseRecordingsRoot: async () => null,
    openRecordingsRoot: async () => undefined,

    pickImage: async () => null,
    pickAudio: async () => null,
    listMusic: async () => [],
    openMusicFolder: async () => console.info('[mock] openMusicFolder'),
    listBackgrounds: async () => [],
    importVideo: async () => null,
    saveVoiceover: async () => {
      throw new Error('Voiceover needs the app')
    },
    transcribeVoiceover: async () => [],
    guideState: async () => null,
    guideMove: async () => undefined,
    onGuideChanged: () => () => undefined,
    saveCaptions: async (_folder, name) => `/mock/exports/${name}.srt`,
    listLooks: async () => ({ presets: [], defaultId: null }),
    cleanMic: async () => 'polish://media/mock/mic.clean.m4a',
    updateState: async () => ({ status: 'idle' as const }),
    installUpdate: async () => undefined,
    onUpdateChanged: () => () => undefined,
    saveLook: async (name, look) => ({ presets: [{ id: 'mock', name, look }], defaultId: null }),
    deleteLook: async () => ({ presets: [], defaultId: null }),
    setDefaultLook: async () => ({ presets: [], defaultId: null }),
    openBackgroundsFolder: async () => console.info('[mock] openBackgroundsFolder'),
    saveImage: async (req) => {
      console.info('[mock] saveImage', req.name, req.format, req.data.byteLength, 'bytes')
      return { path: `${req.folder}\\exports\\${req.name}.${req.format}` }
    },
    setCover: async (req) => {
      console.info('[mock] setCover', req.data.byteLength, 'bytes')
      return { path: `${req.folder}\\exports\\thumb.jpg` }
    },
    startRecording: async () => {
      let seconds = 3
      setState({ status: 'countdown', seconds })
      const tick = setInterval(() => {
        seconds -= 1
        if (seconds > 0) setState({ status: 'countdown', seconds })
        else {
          clearInterval(tick)
          setState({ status: 'recording', folder: FOLDER, startedAt: Date.now(), paused: false })
        }
      }, 1000)
    },
    stopRecording: async () => {
      setState({ status: 'finalizing', folder: FOLDER })
      setTimeout(() => {
        setState({ status: 'idle' })
        openHandlers.forEach((h) => h(FOLDER))
      }, 800)
    },
    recordingState: async () => state,
    onRecordingStateChanged: (h) => {
      stateHandlers.add(h)
      return () => stateHandlers.delete(h)
    },
    listSources: async () => sources,
    windowPreviews: async () => ({}),
    captureCapabilities: async () => ({ cursorFree: true }),
    // ?no-captions shows the panel's state on a build without the engine.
    planAgents: async () => [{ id: 'mock', name: 'Mock agent' }],
    askPlan: async () => ({ plan: null, message: '[mock] No agent in a dev mock.' }),
    setNextTakeLook: async () => undefined,
    captionsStatus: async () =>
      new URLSearchParams(location.search).has('no-captions')
        ? { installed: false, reason: 'Offline captions are not installed on this build. The speech engine (whisper-cli.exe) is not in C:\\ScreenPolish\\resources\\whisper.' }
        : { installed: true, reason: null },
    transcribe: async () => [
      { id: 'cue-0', start: 0.5, end: 3, text: 'This is a caption from the mock bridge.' },
      { id: 'cue-3000', start: 3, end: 6, text: 'Edit any line and it updates the video.' }
    ],
    onTranscribeProgress: () => () => undefined
  }
  window.polish = bridge
  console.info('[mock] window.polish installed')
}
