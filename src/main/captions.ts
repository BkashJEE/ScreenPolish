/**
 * Local transcription for captions: whisper.cpp with the English base model.
 *
 * Both ship with the app (vendor/whisper, fetched and checksummed by
 * scripts/fetch-whisper.sh, packaged as resources/whisper on Linux, Windows
 * and macOS). Nothing is sent anywhere: the audio is converted to 16 kHz mono WAV with the bundled ffmpeg,
 * handed to whisper-cli, and its JSON is read back as caption cues.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CAPTION_LINE_CHARS, CAPTIONS_NOT_INSTALLED, cuesFromWhisperJson, type CaptionCue, type CaptionsStatus } from '../shared/captions'

export const WHISPER_MODEL_FILE = 'ggml-base.en.bin'

export interface WhisperFiles {
  bin: string
  model: string
  /** True in an installed app, where a missing file is the build's fault, not the developer's. */
  packaged?: boolean
}

/** The engine's file name: whisper.cpp's prebuilt Windows release, or the binary built by fetch-whisper.sh. */
export function whisperBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
}

/**
 * Where the bundled whisper-cli and model live, packaged or in a dev checkout.
 * The same resources/whisper directory on every platform; only the binary's
 * name differs.
 */
export function whisperFiles(opts: { isPackaged: boolean; resourcesPath: string; appPath: string; platform: NodeJS.Platform }): WhisperFiles {
  const dir = opts.isPackaged ? path.join(opts.resourcesPath, 'whisper') : path.join(opts.appPath, 'vendor', 'whisper')
  return { bin: path.join(dir, whisperBinaryName(opts.platform)), model: path.join(dir, WHISPER_MODEL_FILE), packaged: opts.isPackaged }
}

/**
 * Why captions cannot run, or null when both files are in place. In a
 * packaged app the message says the build lacks the feature; in a checkout it
 * says how to fetch it.
 */
export function whisperMissing(files: WhisperFiles, exists: (p: string) => boolean = fs.existsSync): string | null {
  const missing = !exists(files.bin) ? 'engine' : !exists(files.model) ? 'model' : null
  if (!missing) return null
  const file = missing === 'engine' ? files.bin : files.model
  if (files.packaged) return `${CAPTIONS_NOT_INSTALLED} The speech ${missing} (${path.basename(file)}) is not in ${path.dirname(file)}.`
  return `The speech ${missing} is missing (${file}). Run scripts/fetch-whisper.sh and rebuild.`
}

/** Checked when the Captions panel opens, so a build without the engine says so before anyone presses Transcribe. */
export function captionsStatus(files: WhisperFiles, exists: (p: string) => boolean = fs.existsSync): CaptionsStatus {
  const reason = whisperMissing(files, exists)
  return { installed: reason === null, reason }
}

/** Leave a couple of cores for the editor; whisper gains little past eight. */
export function whisperThreads(cores: number = os.availableParallelism()): number {
  return Math.max(1, Math.min(8, cores - 2))
}

export function whisperArgs(files: WhisperFiles, wav: string, outBase: string, threads: number): string[] {
  return ['-m', files.model, '-f', wav, '-t', String(threads), '-l', 'en', '-ojf', '-of', outBase, '-np', '-pp', '-ml', String(CAPTION_LINE_CHARS), '-sow', '--prompt', VERBATIM_PROMPT]
}

/**
 * Whisper tidies speech by leaving out "um" and "uh". A short prompt written
 * the way people talk keeps them, which is what Remove filler words needs to
 * find them; the captions' wording is otherwise unchanged.
 */
export const VERBATIM_PROMPT = 'Umm, so, uh, let me show you. Hmm, okay, here it is.'

/** Percent from a whisper-cli progress line on stderr, e.g. "... progress =  45%". */
export function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d+)%/.exec(line)
  return m ? Math.min(100, Number(m[1])) : null
}

function run(bin: string, args: string[], onStderr?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-2000)
      onStderr?.(text)
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with ${code}: ${tail.trim().split('\n').slice(-3).join(' ')}`))))
  })
}

/**
 * Transcribe one of a recording's audio tracks. `onProgress` gets 0..1.
 * Throws with a message fit to show when the track is empty or unreadable.
 */
export async function transcribe(opts: {
  audioFile: string
  ffmpeg: string
  whisper: WhisperFiles
  onProgress?: (fraction: number) => void
}): Promise<CaptionCue[]> {
  const missing = whisperMissing(opts.whisper)
  if (missing) throw new Error(missing)
  const stat = await fs.promises.stat(opts.audioFile).catch(() => null)
  // An audio track that never received a sample is a bare MP4 header.
  if (!stat || stat.size < 1024) throw new Error('That audio track is empty, so there is nothing to transcribe.')

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'polish-captions-'))
  try {
    const wav = path.join(dir, 'audio.wav')
    opts.onProgress?.(0)
    await run(opts.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', opts.audioFile, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
    const outBase = path.join(dir, 'captions')
    await run(opts.whisper.bin, whisperArgs(opts.whisper, wav, outBase, whisperThreads()), (text) => {
      for (const line of text.split('\n')) {
        const pct = parseWhisperProgress(line)
        if (pct !== null) opts.onProgress?.(pct / 100)
      }
    })
    const json = JSON.parse(await fs.promises.readFile(`${outBase}.json`, 'utf8'))
    opts.onProgress?.(1)
    return cuesFromWhisperJson(json)
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
