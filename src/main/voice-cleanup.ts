import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Clean up voice: a copy of the microphone with room noise taken down and the
 * level evened out, made once on this machine with ffmpeg's own filters and
 * kept beside mic.mp4. The editor and the export use it while the switch is
 * on, and the original is never changed, so switching off restores it.
 */

export const CLEAN_MIC_FILE = 'mic.clean.m4a'

/**
 * Rumble below the voice goes first; then an FFT noise reducer that keeps
 * tracking the noise floor as it changes (fans, hum, keyboard); then a gentle
 * compressor that holds back loud peaks so passages sit closer; and a limiter.
 * No makeup gain: lifting the level lifted the noise back with it. Measured
 * on pink noise under a tone: the noise falls about 6 dB, the tone is unchanged.
 */
export function cleanVoiceFilter(): string {
  return [
    'highpass=f=80',
    'afftdn=nr=20:nf=-35:tn=1',
    'acompressor=threshold=-22dB:ratio=3:attack=8:release=160',
    'alimiter=limit=0.95'
  ].join(',')
}

export function cleanVoiceArgs(input: string, output: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-af', cleanVoiceFilter(), '-c:a', 'aac', '-b:a', '192k', output]
}

/** Make (or remake) the cleaned microphone in `dir`; resolves with its path. */
export function cleanMic(ffmpeg: string, dir: string): Promise<string> {
  const input = path.join(dir, 'mic.mp4')
  if (!fs.existsSync(input)) return Promise.reject(new Error('This recording has no microphone track.'))
  const output = path.join(dir, CLEAN_MIC_FILE)
  // Written under a temporary name, so a half-made file is never picked up as the clean voice.
  const tmp = path.join(dir, `.${CLEAN_MIC_FILE}.tmp.m4a`)
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, cleanVoiceArgs(input, tmp), { timeout: 30 * 60_000 }, (error, _out, stderr) => {
      if (error) {
        fs.rmSync(tmp, { force: true })
        reject(new Error(`Could not clean up the voice: ${String(stderr).trim().split('\n').at(-1) || error.message}`))
        return
      }
      fs.renameSync(tmp, output)
      resolve(output)
    })
  })
}
