import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { CLEAN_MIC_FILE, cleanMic, cleanVoiceArgs } from './voice-cleanup'

const ffmpeg = typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic) ? ffmpegStatic : null

/** Mean loudness in dB of `file` between `from` and `to` seconds. */
function meanDb(file: string, from: number, to: number): number {
  const out = spawnSync(ffmpeg!, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)![1])
}

describe('cleanVoiceArgs', () => {
  it('filters the microphone into AAC without touching the input', () => {
    const args = cleanVoiceArgs('/r/mic.mp4', '/r/out.m4a')
    expect(args).toEqual(expect.arrayContaining(['-i', '/r/mic.mp4', '-c:a', 'aac']))
    expect(args.at(-1)).toBe('/r/out.m4a')
    expect(args[args.indexOf('-af') + 1]).toContain('afftdn')
  })
})

describe.skipIf(!ffmpeg)('cleanMic with real ffmpeg', () => {
  it('takes the background noise down and leaves the original alone', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-voice-'))
    const mic = path.join(dir, 'mic.mp4')
    // Eight seconds of steady noise with a tone (the "voice") from 2.5 to 5.5 s.
    execFileSync(ffmpeg!, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.04:duration=8:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3:sample_rate=48000',
      '-filter_complex', '[1]adelay=2500|2500,volume=0.5[v];[0][v]amix=inputs=2:duration=first:normalize=0',
      '-c:a', 'aac', '-b:a', '192k', mic])
    const before = fs.readFileSync(mic)
    const out = await cleanMic(ffmpeg!, dir)
    expect(path.basename(out)).toBe(CLEAN_MIC_FILE)
    expect(fs.readFileSync(mic).equals(before)).toBe(true)
    // The noise after the voice gets clearly quieter; the voice itself keeps its level.
    expect(meanDb(mic, 6, 7.5) - meanDb(out, 6, 7.5)).toBeGreaterThan(4.5)
    expect(Math.abs(meanDb(out, 3, 5) - meanDb(mic, 3, 5))).toBeLessThan(1.5)
    expect(fs.readdirSync(dir).some((f) => f.includes('.tmp'))).toBe(false)
  }, 60_000)

  it('says so when there is no microphone', async () => {
    await expect(cleanMic(ffmpeg!, fs.mkdtempSync(path.join(tmpdir(), 'sp-voice-')))).rejects.toThrow('no microphone')
  })
})
