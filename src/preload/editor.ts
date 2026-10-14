import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EDITOR, type EditorBridge, type ExportRequest, type RecordingState } from '../shared/ipc'
import { latestValue } from '../shared/latest-value'

// Preload runs before did-finish-load. Capture the initial navigation now,
// instead of waiting for React's effect to attach an IPC listener.
const navigation = latestValue<string>()
ipcRenderer.on(EDITOR.open, (_event: IpcRendererEvent, folder: string) => navigation.publish(folder))

const bridge: EditorBridge = {
  onOpen: (handler) => navigation.subscribe(handler),
  load: (folder) => ipcRenderer.invoke(EDITOR.load, folder),
  save: (folder, project) => ipcRenderer.invoke(EDITOR.save, folder, project),
  list: () => ipcRenderer.invoke(EDITOR.list),
  reveal: (path) => ipcRenderer.invoke(EDITOR.reveal, path),
  copyFile: (path) => ipcRenderer.invoke(EDITOR.copyFile, path),
  openFile: (path) => ipcRenderer.invoke(EDITOR.openFile, path),
  dragFile: (path) => ipcRenderer.send(EDITOR.dragFile, path),
  openExternal: (url) => ipcRenderer.invoke(EDITOR.openExternal, url),
  deleteRecording: (folder) => ipcRenderer.invoke(EDITOR.deleteRecording, folder),
  exportBegin: (request) => ipcRenderer.invoke(EDITOR.exportBegin, request),
  exportChunk: (exportId, position, data) => ipcRenderer.invoke(EDITOR.exportChunk, exportId, position, data),
  exportEnd: (request) => ipcRenderer.invoke(EDITOR.exportEnd, request),
  exportAbort: (exportId) => ipcRenderer.invoke(EDITOR.exportAbort, exportId),
  exportProgress: (exportId, fraction) => ipcRenderer.send(EDITOR.exportProgress, exportId, fraction),
  pickImage: () => ipcRenderer.invoke(EDITOR.pickImage),
  pickAudio: () => ipcRenderer.invoke(EDITOR.pickAudio),
  listMusic: () => ipcRenderer.invoke(EDITOR.listMusic),
  openMusicFolder: () => ipcRenderer.invoke(EDITOR.openMusicFolder),
  listBackgrounds: () => ipcRenderer.invoke(EDITOR.listBackgrounds),
  importVideo: () => ipcRenderer.invoke(EDITOR.importVideo),
  openBackgroundsFolder: () => ipcRenderer.invoke(EDITOR.openBackgroundsFolder),
  saveImage: (request) => ipcRenderer.invoke(EDITOR.saveImage, request),
  setCover: (request) => ipcRenderer.invoke(EDITOR.setCover, request),
  startRecording: (request) => ipcRenderer.invoke(EDITOR.startRecording, request),
  stopRecording: () => ipcRenderer.invoke(EDITOR.stopRecording),
  recordingState: () => ipcRenderer.invoke(EDITOR.recordingState),
  onRecordingStateChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, state: RecordingState): void => handler(state)
    ipcRenderer.on(EDITOR.recordingStateChanged, listener)
    return () => ipcRenderer.removeListener(EDITOR.recordingStateChanged, listener)
  },
  listSources: () => ipcRenderer.invoke(EDITOR.listSources),
  windowPreviews: (ids) => ipcRenderer.invoke(EDITOR.windowPreviews, ids),
  captureCapabilities: () => ipcRenderer.invoke(EDITOR.captureCapabilities),
  captionsStatus: () => ipcRenderer.invoke(EDITOR.captionsStatus),
  planAgents: () => ipcRenderer.invoke(EDITOR.planAgents),
  askPlan: (agentId, context, history) => ipcRenderer.invoke(EDITOR.askPlan, agentId, context, history),
  setNextTakeLook: (look) => ipcRenderer.invoke(EDITOR.setNextTakeLook, look),
  transcribe: (folder, source) => ipcRenderer.invoke(EDITOR.transcribe, folder, source),
  onTranscribeProgress: (handler) => {
    const listener = (_event: IpcRendererEvent, fraction: number): void => handler(fraction)
    ipcRenderer.on(EDITOR.transcribeProgress, listener)
    return () => ipcRenderer.removeListener(EDITOR.transcribeProgress, listener)
  },
  onExportRequest: (handler) => {
    const listener = (_event: IpcRendererEvent, request: ExportRequest): void => handler(request)
    ipcRenderer.on(EDITOR.exportRequest, listener)
    return () => ipcRenderer.removeListener(EDITOR.exportRequest, listener)
  },
  pendingExport: (folder) => ipcRenderer.invoke(EDITOR.pendingExport, folder),
  exportRequestDone: (result) => ipcRenderer.send(EDITOR.exportRequestDone, result),
  saveRecordDefaults: (defaults) => ipcRenderer.send(EDITOR.saveRecordDefaults, defaults),
  getSettings: () => ipcRenderer.invoke(EDITOR.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(EDITOR.saveSettings, patch),
  chooseRecordingsRoot: () => ipcRenderer.invoke(EDITOR.chooseRecordingsRoot),
  openRecordingsRoot: () => ipcRenderer.invoke(EDITOR.openRecordingsRoot)
}

contextBridge.exposeInMainWorld('polish', bridge)
