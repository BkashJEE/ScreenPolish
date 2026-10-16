// Command line front door. Any `Polish.exe <command>` invocation is a CLIENT:
// it makes sure a server instance (the tray app) exists, hands the command to
// it through Electron's single-instance channel, waits for a reply file and
// prints one JSON object. The server executes commands against the live
// RecordingSession, so `record start` in one call and `record stop` in the
// next just work, and an agent can film its own work.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, screen, type Display } from 'electron'
import type { StartRecordingRequest } from '@shared/ipc'
import type { RecordingSummary } from '@shared/types'
import { CliUsageError, HELP, parseCli, replyTimeoutMs, type CliCommand, type ExportOptions, type StartOptions } from './cli-parse'
import { assertInsideRoot } from './export-sink'
import { requestExport } from './export-requests'
import { listRecordings } from './ipc'
import { recordingsRoot } from './media-protocol'
import type { RecordingSession } from './recording-session'
import { regionFromOverlayRect } from './region-math'
import { replayBuffer } from './replay'
import { claimServerSpawn, serverExecutable } from './server-lock'
import { openEditor } from './windows'
import { createSequenceFolder, isSequenceFolder, readSequence } from './sequence'
import { isRecordingFolderName } from './naming'

export interface CliPayload {
  cli: string[]
  replyId: string
}

export type CliResult = { ok: true; [key: string]: unknown } | { ok: false; error: string }

/** argv without the executable (and without the app path in dev). */
export function cliArgs(): string[] {
  return process.argv.slice(app.isPackaged ? 1 : 2)
}

function replyDir(): string {
  return path.join(app.getPath('userData'), 'cli')
}

function replyPath(replyId: string): string {
  return path.join(replyDir(), `${replyId}.json`)
}

function print(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- client -------------------------------------------------------------------

/**
 * Runs before app ready. Parses argv, ensures a server, sends the command,
 * waits for the reply, prints it and exits. Never returns.
 */
export async function runCliClient(argv: string[]): Promise<never> {
  let command: CliCommand
  try {
    command = parseCli(argv)
  } catch (err) {
    print({ ok: false, error: err instanceof CliUsageError ? `${err.message}\n\n${HELP}` : String(err) })
    return exit(1)
  }
  if (command.kind === 'help') {
    process.stdout.write(`${HELP}\n`)
    return exit(0)
  }

  const replyId = randomUUID()
  const payload: CliPayload = { cli: argv, replyId }
  // Asking whether anything is recording must not start the app: a status
  // poll used to bring ScreenPolish back seconds after it was quit.
  const started = await ensureServer(payload, command.kind !== 'status')
  if (!started && command.kind === 'status') {
    print({ ok: true, running: false, state: { status: 'idle' }, lastFolder: null })
    return exit(0)
  }
  if (!started) {
    print({ ok: false, error: 'Could not start the Polish server instance' })
    return exit(1)
  }

  const file = replyPath(replyId)
  const deadline = Date.now() + replyTimeoutMs(command)
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      await sleep(50)
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
        fs.unlinkSync(file)
      } catch {
        // partially written; try again next tick
        await sleep(100)
        continue
      }
      process.stdout.write(`${text.trim()}\n`)
      let ok = false
      try {
        ok = (JSON.parse(text) as CliResult).ok
      } catch {
        ok = false
      }
      return exit(ok ? 0 : 1)
    }
    await sleep(200)
  }
  print({ ok: false, error: `Timed out waiting for Polish (${command.kind})` })
  return exit(1)
}

function exit(code: number): never {
  // Give stdout a moment to flush through the pipe before the process dies.
  setTimeout(() => app.exit(code), 60)
  return new Promise<never>(() => undefined) as unknown as never
}

/**
 * True once a server instance holds the single-instance lock and has received
 * `payload` through its second-instance event. If nobody holds the lock, we
 * spawn a detached server and hand over.
 */
async function ensureServer(payload: CliPayload, spawnIfMissing = true): Promise<boolean> {
  if (!app.requestSingleInstanceLock(payload)) return true
  app.releaseSingleInstanceLock()
  if (!spawnIfMissing) return false
  // Only one client gets to start a server. Without this, three CLI calls in a
  // row each found no server and each spawned one, leaving three live apps.
  if (claimServerSpawn(replyDir())) spawnServer()
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await sleep(400)
    if (!app.requestSingleInstanceLock(payload)) return true
    app.releaseSingleInstanceLock()
  }
  return false
}

function spawnServer(): void {
  const args = app.isPackaged ? [] : [app.getAppPath()]
  const child = spawn(serverExecutable(), args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, POLISH_SERVER: '1' },
    windowsHide: false
  })
  child.unref()
}

// --- server -------------------------------------------------------------------

export interface CliContext {
  session: RecordingSession
  durationOf: (file: string) => Promise<number | null>
}

/** Handle a second-instance payload on the server. */
export async function handleCliPayload(data: unknown, ctx: CliContext): Promise<void> {
  const payload = data as Partial<CliPayload> | undefined
  if (!payload || !Array.isArray(payload.cli) || typeof payload.replyId !== 'string') {
    openEditor('')
    return
  }
  let result: CliResult
  try {
    result = await executeCli(parseCli(payload.cli), ctx)
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  writeReply(payload.replyId, result)
}

function writeReply(replyId: string, result: CliResult): void {
  try {
    fs.mkdirSync(replyDir(), { recursive: true })
    const file = replyPath(replyId)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(result))
    fs.renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.error('[cli] could not write reply', err)
  }
}

function displaysInOrder(): Display[] {
  return [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
}

function pickDisplay(choice: StartOptions['display']): Display {
  if (choice === 'primary') return screen.getPrimaryDisplay()
  const list = displaysInOrder()
  const d = list[choice - 1]
  if (!d) throw new Error(`No display ${choice}; ${list.length} attached`)
  return d
}

export function startRequestFor(start: StartOptions): StartRecordingRequest {
  const display = pickDisplay(start.display)
  const source: StartRecordingRequest['source'] = start.region
    ? {
        kind: 'region',
        displayId: display.id,
        // --region is physical px relative to the display; regionFromOverlayRect
        // wants DIP, so divide by the scale first.
        region: regionFromOverlayRect(display, {
          x: start.region.x / display.scaleFactor,
          y: start.region.y / display.scaleFactor,
          width: start.region.width / display.scaleFactor,
          height: start.region.height / display.scaleFactor
        })
      }
    : { kind: 'screen', displayId: display.id }
  return {
    source,
    mic: start.mic ? { deviceId: 'default' } : null,
    system: start.system,
    webcam: start.webcam ? { deviceId: 'default' } : null,
    fps: start.fps
  }
}

/** A recording or a sequence: an absolute path, a folder name, or a sequence's name. */
function resolveFolder(input: string): string {
  const root = recordingsRoot()
  const candidate = path.isAbsolute(input) ? input : path.join(root, input)
  const folder = assertInsideRoot(root, candidate)
  if (fs.existsSync(path.join(folder, 'screen.mp4')) || isSequenceFolder(folder)) return folder
  const named = sequenceNamed(root, input)
  if (named) return named
  throw new Error(`No recording or sequence at ${folder}`)
}

/** The newest sequence titled `name`, ignoring case. */
function sequenceNamed(root: string, name: string): string | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted || !fs.existsSync(root)) return null
  const folders = fs
    .readdirSync(root)
    .filter(isRecordingFolderName)
    .sort()
    .reverse()
  for (const f of folders) {
    const folder = path.join(root, f)
    if (!isSequenceFolder(folder)) continue
    try {
      if (readSequence(root, folder).title.toLowerCase() === wanted) return folder
    } catch {
      // Unreadable; not this one.
    }
  }
  return null
}

async function waitForIdle(session: RecordingSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (session.state.status !== 'idle' && Date.now() < deadline) await sleep(100)
}

async function exportIfAsked(folder: string, exp: ExportOptions): Promise<{ export?: string }> {
  if (!exp.kind) return {}
  const sequence = isSequenceFolder(folder)
  const name = exp.name ?? (sequence ? readSequence(recordingsRoot(), folder).title : '') ?? ''
  // A sequence renders every take it uses, so it gets longer than one take.
  const out = await requestExport(folder, exp.kind, name || `${path.basename(folder)}-${exp.kind}`, sequence ? 60 * 60 * 1000 : undefined)
  return { export: out }
}

export async function executeCli(command: CliCommand, ctx: CliContext): Promise<CliResult> {
  const { session } = ctx
  switch (command.kind) {
    case 'help':
      return { ok: true, help: HELP }
    case 'status':
      return { ok: true, running: true, state: session.state, lastFolder: session.lastFolder }
    case 'list': {
      const recordings: RecordingSummary[] = await listRecordings(recordingsRoot(), ctx.durationOf)
      return { ok: true, root: recordingsRoot(), recordings }
    }
    case 'replay-start': {
      if (session.isActive) throw new Error('Stop the recording before holding a replay buffer; they cannot both have the screen.')
      const display = pickDisplay(command.start.display)
      const state = await replayBuffer.start({
        root: recordingsRoot(),
        displayBounds: display.bounds,
        seconds: command.seconds,
        fps: command.start.fps
      })
      return { ok: true, replay: state }
    }
    case 'replay-save': {
      const { clip, state } = await replayBuffer.save()
      if (!clip) return { ok: false, error: 'The replay was asked for but no clip appeared. Check the replay folder, and that there is room on disk.' }
      return { ok: true, clip, replay: state }
    }
    case 'replay-stop':
      return { ok: true, replay: await replayBuffer.stop() }
    case 'open': {
      const folder = command.folder ? resolveFolder(command.folder) : ''
      openEditor(folder)
      return { ok: true, folder }
    }
    case 'record-start': {
      await session.start(startRequestFor(command.start))
      return { ok: true, folder: session.lastFolder, state: session.state }
    }
    case 'record-stop': {
      if (!session.isActive) return { ok: false, error: 'Not recording' }
      const folder = session.lastFolder
      await session.stop()
      await waitForIdle(session, 30_000)
      if (!folder || !fs.existsSync(path.join(folder, 'screen.mp4'))) return { ok: false, error: 'Recording produced no video' }
      return { ok: true, folder, ...(await exportIfAsked(folder, command.export)) }
    }
    case 'clip': {
      await session.start(startRequestFor(command.start))
      const folder = session.lastFolder
      await sleep(command.seconds * 1000)
      await session.stop()
      await waitForIdle(session, 30_000)
      if (!folder || !fs.existsSync(path.join(folder, 'screen.mp4'))) return { ok: false, error: 'Recording produced no video' }
      return { ok: true, folder, seconds: command.seconds, ...(await exportIfAsked(folder, command.export)) }
    }
    case 'export': {
      const folder = resolveFolder(command.folder)
      const out = await exportIfAsked(folder, command.export)
      return { ok: true, folder, ...out }
    }
    case 'sequence-create': {
      const root = recordingsRoot()
      const takes = command.takes.map((t) => path.basename(resolveFolder(t)))
      for (const t of takes) if (isSequenceFolder(path.join(root, t))) throw new Error(`${t} is a sequence; a sequence is made of takes.`)
      const { folder, sequence } = createSequenceFolder(root, takes, command.title ?? '')
      return { ok: true, folder, name: sequence.title || path.basename(folder), sequence }
    }
    case 'quit': {
      if (session.isActive) return { ok: false, error: 'Recording in progress; stop it first' }
      setTimeout(() => app.quit(), 300)
      return { ok: true, quitting: true }
    }
  }
}
