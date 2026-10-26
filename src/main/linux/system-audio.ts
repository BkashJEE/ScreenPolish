import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const BYTES_PER_SECOND = 48000 * 2 * 2

export function monitorArgs(sink: string, raw = true): string[] {
  if (!sink.trim() || sink.startsWith('-')) throw new Error('No default output device was found')
  // `--raw` is not available in older pw-cat builds (e.g. PipeWire 1.0.x on Ubuntu 24.04 / Mint 22),
  // which already write raw PCM to stdout and reject the unknown option.
  return ['--record', ...(raw ? ['--raw'] : []), '--format', 's16', '--rate', '48000', '--channels', '2',
    '--latency', '20ms', '--target', sink.trim(), '--properties',
    '{ stream.capture.sink = true node.dont-reconnect = true }', '-']
}

/** Bytes of leading silence needed to align the first PCM block to video time. */
export function leadingSilence(startedAt: number, receivedAt: number, blockBytes: number): number {
  const elapsed = Math.max(0, Math.min(10, (receivedAt - startedAt) / 1000))
  return Math.max(0, Math.round((elapsed * BYTES_PER_SECOND - blockBytes) / 4) * 4)
}

let rawSupport: Promise<boolean> | null = null

/** True when the installed pw-cat understands `--raw` (checked once via `pw-cat --help`). */
export function pwCatSupportsRaw(): Promise<boolean> {
  rawSupport ??= exec('pw-cat', ['--help'], { timeout: 3000 })
    .then(({ stdout, stderr }) => /--raw\b/.test(stdout + stderr))
    .catch(() => true)
  return rawSupport
}

/** Native PipeWire output monitor. Never opens or falls back to a microphone. */
export class SystemAudioRecorder {
  private capture: ChildProcessWithoutNullStreams | null = null
  private encoder: ChildProcessWithoutNullStreams | null = null
  private captured: Promise<void> = Promise.resolve()
  private encoded: Promise<void> = Promise.resolve()
  private paused = false
  private stopping = false
  private failure: Error | null = null
  private stopPromise: Promise<void> | null = null

  async start(file: string, ffmpeg: string, startedAt: number, warn: (message: string) => void): Promise<void> {
    const { stdout } = await exec('pactl', ['get-default-sink'], { timeout: 3000 })
    const capture = spawn('pw-cat', monitorArgs(stdout, await pwCatSupportsRaw()), { stdio: 'pipe' })
    const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-n', file], { stdio: 'pipe' })
    this.capture = capture
    this.encoder = encoder
    let detail = ''
    const fail = (error: Error) => {
      if (!this.failure) { this.failure = error; warn(`System audio: ${error.message}`) }
    }
    for (const child of [capture, encoder]) {
      child.stderr.on('data', (data) => { detail = (detail + String(data)).slice(-1500) })
      child.on('error', fail)
    }
    encoder.stdin.on('error', (error) => { if (!this.stopping) fail(error) })
    this.captured = new Promise(resolve => capture.once('close', () => {
      if (!this.stopping) fail(new Error(detail || 'PipeWire monitor stopped unexpectedly'))
      encoder.stdin.end()
      resolve()
    }))
    this.encoded = new Promise(resolve => encoder.once('close', (code) => {
      if (code !== 0) fail(new Error(detail || `Audio encoder exited with code ${code}`))
      if (!this.stopping) capture.kill('SIGINT')
      resolve()
    }))
    await new Promise<void>((resolve, reject) => {
      let first = true
      const timer = setTimeout(() => reject(new Error('PipeWire output monitor produced no audio within 5 seconds')), 5000)
      capture.once('error', (error) => { clearTimeout(timer); reject(error) })
      capture.stdout.on('data', (data: Buffer) => {
        if (first) {
          first = false
          clearTimeout(timer)
          const padding = leadingSilence(startedAt, Date.now(), data.length)
          if (padding > 0) encoder.stdin.write(Buffer.alloc(padding))
          resolve()
        }
        // Keep consuming the live stream while paused; do not queue paused audio.
        if (!this.paused && !this.stopping && !encoder.stdin.destroyed) {
          if (!encoder.stdin.write(data)) capture.stdout.pause()
        }
      })
      encoder.stdin.on('drain', () => capture.stdout.resume())
    }).catch(async error => { await this.stop().catch(() => undefined); throw error })
    if (this.failure) throw this.failure
  }

  setPaused(paused: boolean): void { this.paused = paused }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopPromise = (async () => {
      this.capture?.stdout.resume()
      this.capture?.kill('SIGINT')
      const deadline = setTimeout(() => {
        this.capture?.kill('SIGKILL')
        this.encoder?.kill('SIGKILL')
      }, 8000)
      try {
        await this.captured
        this.encoder?.stdin.end()
        await this.encoded
      } finally { clearTimeout(deadline) }
      if (this.failure) throw this.failure
    })()
    return this.stopPromise
  }
}
