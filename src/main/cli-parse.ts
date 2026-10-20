// Pure argv parsing for the `polish` command line. No Electron imports so it
// is unit-testable.
//
//   polish status
//   polish list
//   polish record start [--display primary|N] [--region X,Y,W,H] [--mic] [--no-system] [--webcam] [--fps 30|60]
//   polish record stop  [--export mp4|gif] [--name NAME]
//   polish clip --seconds N [start options] [--export mp4|gif] [--name NAME]
//   polish export FOLDER [--kind mp4|gif] [--name NAME]
//   polish replay start --seconds N [start options]
//   polish replay save
//   polish replay stop
//   polish open [FOLDER]
//   polish sequence create [--out NAME] TAKE TAKE...
//
// Every command prints one JSON object on stdout and exits 0 on success, 1 on
// failure. FOLDER is an absolute path or a recording name under the library,
// or a sequence's name.

import type { ExportKind } from '@shared/ipc'

export interface StartOptions {
  display: 'primary' | number
  region: null | { x: number; y: number; width: number; height: number }
  mic: boolean
  system: boolean
  webcam: boolean
  fps: 30 | 60
}

export interface ExportOptions {
  kind: ExportKind | null
  name: string | null
}

export type CliCommand =
  | { kind: 'status' }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'record-start'; start: StartOptions }
  | { kind: 'record-stop'; export: ExportOptions }
  | { kind: 'clip'; seconds: number; start: StartOptions; export: ExportOptions }
  | { kind: 'export'; folder: string; export: ExportOptions }
  | { kind: 'replay-start'; seconds: number; start: StartOptions }
  | { kind: 'replay-save' }
  | { kind: 'replay-stop' }
  | { kind: 'open'; folder: string | null }
  | { kind: 'sequence-create'; takes: string[]; title: string | null }
  | { kind: 'quit' }

export const DEFAULT_START: StartOptions = { display: 'primary', region: null, mic: false, system: true, webcam: false, fps: 30 }

const COMMAND_WORDS = new Set(['status', 'list', 'record', 'replay', 'clip', 'export', 'open', 'sequence', 'quit', 'help', '--help', '-h'])

/** True when argv (already stripped of the executable) starts a CLI command. */
export function looksLikeCli(args: readonly string[]): boolean {
  const first = args.find((a) => !isElectronNoise(a))
  return first !== undefined && COMMAND_WORDS.has(first)
}

/** Flags Electron/Chromium/electron-vite may put on argv that are not ours. */
export function isElectronNoise(arg: string): boolean {
  return (
    arg === '.' ||
    arg.startsWith('--inspect') ||
    arg.startsWith('--remote-debugging') ||
    arg.startsWith('--enable-') ||
    arg.startsWith('--disable-') ||
    arg.startsWith('--no-sandbox') ||
    arg.startsWith('--allow-') ||
    arg.startsWith('--original-process-start-time') ||
    arg.startsWith('--user-data-dir') ||
    arg.startsWith('--ozone')
  )
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export const HELP = `polish — screen recorder with automatic polish

  polish status
  polish list
  polish record start [--display primary|N] [--region X,Y,W,H] [--mic] [--no-system] [--webcam] [--fps 30|60]
  polish record stop  [--export mp4|gif] [--name NAME]
  polish clip --seconds N [start options] [--export mp4|gif] [--name NAME]
  polish export FOLDER [--kind mp4|gif] [--name NAME]
  polish replay start --seconds N [start options]   hold the last N seconds, writing nothing
  polish replay save                                write what is held to a clip
  polish replay stop                                stop holding
  polish open [FOLDER]
  polish sequence create [--out NAME] TAKE TAKE...   one video from several takes, in order;
                                                    then: polish export NAME
  polish quit                              stop the tray app (refused while recording)

Output is one JSON object per command. Exit code 0 on success, 1 on failure.
--region is in physical pixels relative to the chosen display's top-left.`

function takeValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw new CliUsageError(`${flag} needs a value`)
  return v
}

function parseStartAndExport(args: string[], allowExport: boolean): { start: StartOptions; export: ExportOptions; rest: string[]; seconds: number | null } {
  const start: StartOptions = { ...DEFAULT_START }
  const exp: ExportOptions = { kind: null, name: null }
  const rest: string[] = []
  let seconds: number | null = null
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    switch (a) {
      case '--display': {
        const v = takeValue(args, i, a)
        i += 1
        if (v === 'primary') start.display = 'primary'
        else {
          const n = Number(v)
          if (!Number.isInteger(n) || n < 1) throw new CliUsageError('--display expects "primary" or a 1-based display number')
          start.display = n
        }
        break
      }
      case '--region': {
        const v = takeValue(args, i, a)
        i += 1
        const parts = v.split(',').map((s) => Number(s.trim()))
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) {
          throw new CliUsageError('--region expects X,Y,W,H in pixels')
        }
        start.region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
        break
      }
      case '--mic':
        start.mic = true
        break
      case '--no-mic':
        start.mic = false
        break
      case '--system':
        start.system = true
        break
      case '--no-system':
        start.system = false
        break
      case '--webcam':
        start.webcam = true
        break
      case '--fps': {
        const v = Number(takeValue(args, i, a))
        i += 1
        if (v !== 30 && v !== 60) throw new CliUsageError('--fps expects 30 or 60')
        start.fps = v
        break
      }
      case '--seconds': {
        const v = Number(takeValue(args, i, a))
        i += 1
        if (!Number.isFinite(v) || v <= 0) throw new CliUsageError('--seconds expects a positive number')
        seconds = v
        break
      }
      case '--export':
      case '--kind': {
        if (!allowExport) throw new CliUsageError(`${a} is not valid here`)
        const v = takeValue(args, i, a)
        i += 1
        if (v !== 'mp4' && v !== 'gif') throw new CliUsageError(`${a} expects mp4 or gif`)
        exp.kind = v
        break
      }
      case '--name': {
        if (!allowExport) throw new CliUsageError('--name is not valid here')
        exp.name = takeValue(args, i, a)
        i += 1
        break
      }
      default:
        if (a.startsWith('--')) throw new CliUsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }
  return { start, export: exp, rest, seconds }
}

export function parseCli(argv: readonly string[]): CliCommand {
  const args = argv.filter((a) => !isElectronNoise(a))
  const [cmd, ...tail] = args
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' }
    case 'status':
      return { kind: 'status' }
    case 'list':
      return { kind: 'list' }
    case 'record': {
      const [sub, ...opts] = tail
      if (sub === 'start') {
        const parsed = parseStartAndExport(opts, false)
        if (parsed.rest.length) throw new CliUsageError(`Unexpected argument ${parsed.rest[0]}`)
        return { kind: 'record-start', start: parsed.start }
      }
      if (sub === 'stop') {
        const parsed = parseStartAndExport(opts, true)
        if (parsed.rest.length) throw new CliUsageError(`Unexpected argument ${parsed.rest[0]}`)
        return { kind: 'record-stop', export: parsed.export }
      }
      throw new CliUsageError('record expects start or stop')
    }
    case 'replay': {
      const [sub, ...opts] = tail
      if (sub === 'start') {
        const parsed = parseStartAndExport(opts, false)
        if (parsed.rest.length) throw new CliUsageError(`Unexpected argument ${parsed.rest[0]}`)
        if (parsed.seconds === null) throw new CliUsageError('replay start needs --seconds N')
        return { kind: 'replay-start', seconds: parsed.seconds, start: parsed.start }
      }
      if (sub === 'save') {
        if (opts.length) throw new CliUsageError(`Unexpected argument ${opts[0]}`)
        return { kind: 'replay-save' }
      }
      if (sub === 'stop') {
        if (opts.length) throw new CliUsageError(`Unexpected argument ${opts[0]}`)
        return { kind: 'replay-stop' }
      }
      throw new CliUsageError('replay expects start, save or stop')
    }
    case 'clip': {
      const parsed = parseStartAndExport(tail, true)
      if (parsed.seconds === null) throw new CliUsageError('clip needs --seconds N')
      if (parsed.rest.length) throw new CliUsageError(`Unexpected argument ${parsed.rest[0]}`)
      return { kind: 'clip', seconds: parsed.seconds, start: parsed.start, export: parsed.export }
    }
    case 'export': {
      const parsed = parseStartAndExport(tail, true)
      const folder = parsed.rest[0]
      if (!folder) throw new CliUsageError('export needs a recording folder or name')
      return { kind: 'export', folder, export: { kind: parsed.export.kind ?? 'mp4', name: parsed.export.name } }
    }
    case 'open':
      return { kind: 'open', folder: tail[0] ?? null }
    case 'sequence': {
      const [sub, ...opts] = tail
      if (sub !== 'create') throw new CliUsageError('sequence expects create')
      let title: string | null = null
      const takes: string[] = []
      for (let i = 0; i < opts.length; i += 1) {
        const a = opts[i]!
        if (a === '--out' || a === '--name') {
          title = takeValue(opts, i, a)
          i += 1
        } else if (a.startsWith('--')) throw new CliUsageError(`Unknown option ${a}`)
        else takes.push(a)
      }
      if (takes.length === 0) throw new CliUsageError('sequence create needs one or more takes, in order')
      return { kind: 'sequence-create', takes, title }
    }
    case 'quit':
      return { kind: 'quit' }
    default:
      throw new CliUsageError(`Unknown command ${cmd}`)
  }
}

/** How long a client should wait for the primary instance to answer. */
export function replyTimeoutMs(command: CliCommand): number {
  switch (command.kind) {
    case 'clip':
      return (command.seconds + 150) * 1000 + (command.export.kind ? 10 * 60 * 1000 : 0)
    case 'record-start':
      return 150 * 1000
    // Starting a buffer settles for under a second; saving waits for gsr to
    // flush the clip. Neither is long, but neither is instant either.
    case 'replay-start':
      return 30 * 1000
    case 'replay-save':
      return 60 * 1000
    case 'record-stop':
      return 60 * 1000 + (command.export.kind ? 10 * 60 * 1000 : 0)
    // A sequence renders every take it uses, then joins them.
    case 'export':
      return 60 * 60 * 1000
    default:
      return 30 * 1000
  }
}
