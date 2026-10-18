import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { mixVoiceover, probeFile, saveVoiceover, voiceoverFile } from './voiceover'

const ffmpeg = ffmpegStatic as unknown as string
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-voice-'))

/** RMS level (dB) of one frequency band of `file` between `from` and `to` seconds. */
function level(file: string, hz: number, from: number, to: number): number {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', `bandpass=f=${hz}:w=60,astats`, '-f', 'null', '-'])
  const m = /Overall[\s\S]*?RMS level dB: (-?[\d.]+|-inf)/.exec(String(r.stderr))
  return !m || m[1] === '-inf' ? -200 : Number(m[1])
}

describe('saving a voiceover', () => {
  it('turns the recording into AAC beside the take, and refuses an empty one', async () => {
    const d = dir()
    const webm = path.join(d, 'in.webm')
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=1.5', '-c:a', 'libopus', webm])
    const saved = await saveVoiceover(ffmpeg, d, new Uint8Array(fs.readFileSync(webm)))
    expect(saved.file).toMatch(/^voiceover-[0-9a-f]{12}\.m4a$/)
    expect(saved.durationSec).toBeGreaterThan(1.4)
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.webm') && f !== 'in.webm')).toEqual([])
    await expect(saveVoiceover(ffmpeg, d, new Uint8Array(10))).rejects.toThrow(/Nothing was recorded/)
    expect(() => voiceoverFile(d, '../in.webm')).toThrow(/Not a voiceover/)
  }, 30_000)
})

describe('mixing a voiceover into an export', () => {
  it('puts the voice at its time and lowers the take under it', async () => {
    const d = dir()
    const mp4 = path.join(d, 'export.mp4')
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4])
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=2', '-c:a', 'aac', path.join(d, 'voiceover-abcd1234.m4a')])
    const before = level(mp4, 300, 2.3, 3.7)
    await mixVoiceover(ffmpeg, mp4, d, [{ file: 'voiceover-abcd1234.m4a', atSec: 2, volume: 1 }], { hasAudio: true, durationSec: 6, duck: true })
    const p = (await probeFile(ffmpeg, mp4))!
    expect(p.durationSec).toBeGreaterThan(5.9)
    expect(p.durationSec).toBeLessThan(6.2)
    // The voice is there while it should be, and not before.
    expect(level(mp4, 800, 2.3, 3.7)).toBeGreaterThan(level(mp4, 800, 0.2, 1.6) + 20)
    // The take's own tone is ducked while the voice plays, and back afterwards.
    expect(level(mp4, 300, 2.3, 3.7)).toBeLessThan(before - 6)
    expect(level(mp4, 300, 4.8, 5.8)).toBeGreaterThan(before - 4)
  }, 60_000)

  it('gives a silent export a sound track of the voice alone', async () => {
    const d = dir()
    const mp4 = path.join(d, 'export.mp4')
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4])
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=1', '-c:a', 'aac', path.join(d, 'voiceover-abcd1234.m4a')])
    await mixVoiceover(ffmpeg, mp4, d, [{ file: 'voiceover-abcd1234.m4a', atSec: 1, volume: 1 }], { hasAudio: false, durationSec: 4, duck: true })
    const p = (await probeFile(ffmpeg, mp4))!
    expect(p.audioCodec).toBe('aac')
    expect(p.durationSec).toBeGreaterThan(3.9)
  }, 60_000)
})
