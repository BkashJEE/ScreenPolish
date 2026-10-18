import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VOICEOVER_FILE_RE, voiceoverMixArgs } from '@shared/voiceover'
import { parseProbe } from './import-video'

/**
 * Voiceover files on disk: a recording made in the editor is saved beside
 * the take as voiceover-<id>.m4a, and a finished export gets the voiceover
 * mixed in as its last step. See src/shared/voiceover.ts.
 */

/** Longest voiceover the editor may hand over in one piece. */
export const MAX_VOICEOVER_BYTES = 200 * 1024 * 1024

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) reject(new Error(`ffmpeg failed: ${String(stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ') || error.message}`))
      else resolve(String(stderr ?? ''))
    })
  })
}

async function probeSeconds(ffmpeg: string, file: string): Promise<number> {
  const info = await new Promise<string>((resolve) => execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _o, stderr) => resolve(String(stderr ?? ''))))
  const duration = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(info)
  return duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0
}

/**
 * Save what the editor recorded (WebM/Opus from MediaRecorder) as AAC in the
 * take's folder. Resolves with the file's name and length.
 */
export async function saveVoiceover(ffmpeg: string, folder: string, data: Uint8Array): Promise<{ file: string; durationSec: number }> {
  if (data.byteLength < 512) throw new Error('Nothing was recorded. Check that the microphone is on and allowed.')
  if (data.byteLength > MAX_VOICEOVER_BYTES) throw new Error('That voiceover is too long to save in one piece.')
  const id = randomBytes(6).toString('hex')
  const file = `voiceover-${id}.m4a`
  const raw = path.join(folder, `voiceover-${id}.recording.webm`)
  const target = path.join(folder, file)
  await fs.promises.writeFile(raw, data)
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', target])
  } finally {
    await fs.promises.rm(raw, { force: true })
  }
  const durationSec = await probeSeconds(ffmpeg, target)
  if (!(durationSec > 0.05)) {
    await fs.promises.rm(target, { force: true })
    throw new Error('The voiceover came out empty. Try recording again.')
  }
  return { file, durationSec }
}

/** A voiceover file of the take in `folder`, by name; throws for anything else. */
export function voiceoverFile(folder: string, file: string): string {
  if (!VOICEOVER_FILE_RE.test(file)) throw new Error(`Not a voiceover: ${file}`)
  const abs = path.join(folder, file)
  if (!fs.existsSync(abs)) throw new Error(`The voiceover ${file} is missing from the take.`)
  return abs
}

/**
 * Lay the voiceover over a finished MP4 in place: each clip at its output
 * time, the take's sound lowered under it when `duck`.
 */
export async function mixVoiceover(
  ffmpeg: string,
  mp4: string,
  folder: string,
  voices: ReadonlyArray<{ file: string; atSec: number; volume: number }>,
  opts: { hasAudio: boolean; durationSec: number; duck: boolean }
): Promise<void> {
  if (voices.length === 0) return
  const resolved = voices.map((v) => ({ path: voiceoverFile(folder, v.file), atSec: v.atSec, volume: v.volume }))
  const out = `${mp4}.voice.mp4`
  try {
    await run(ffmpeg, voiceoverMixArgs(mp4, resolved, opts, out))
    await fs.promises.rename(out, mp4)
  } finally {
    await fs.promises.rm(out, { force: true })
  }
}

/** For tests: the probe used on a finished file. */
export const probeFile = async (ffmpeg: string, file: string) =>
  parseProbe(await new Promise<string>((resolve) => execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _o, stderr) => resolve(String(stderr ?? '')))))
