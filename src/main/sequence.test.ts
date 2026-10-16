import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { SEQUENCE_FILE } from '@shared/sequence'
import { parseProbe } from './import-video'
import { SEQUENCE_PARTS_DIR, createSequenceFolder, isSequenceFolder, joinSequence, parseProgressSeconds, readSequence, saveSequence } from './sequence'

const ffmpeg = ffmpegStatic as unknown as string

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sp-seq-'))
}

function take(dir: string, name: string): string {
  const folder = path.join(dir, name)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'screen.mp4'), 'x')
  return folder
}

function clip(file: string, seconds: number, size: string, withAudio: boolean): void {
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=${size}:rate=30`,
    ...(withAudio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file
  ])
}

function probe(file: string) {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' })
  } catch (e) {
    return parseProbe(String((e as { stderr: Buffer }).stderr))
  }
  return null
}

describe('sequence folders', () => {
  it('are made from takes in the recordings folder, and only from takes', () => {
    const r = root()
    take(r, '2026-10-15_12-00-00')
    take(r, '2026-10-15_12-05-00')
    const { folder, sequence } = createSequenceFolder(r, ['2026-10-15_12-00-00', path.join(r, '2026-10-15_12-05-00')], 'Reel', new Date(2026, 9, 15, 13, 0, 0))
    expect(path.basename(folder)).toBe('2026-10-15_13-00-00')
    expect(isSequenceFolder(folder)).toBe(true)
    expect(sequence.clips.map((c) => c.take)).toEqual(['2026-10-15_12-00-00', '2026-10-15_12-05-00'])
    expect(readSequence(r, folder)).toEqual(sequence)
    expect(() => createSequenceFolder(r, ['nope'])).toThrow(/not a recording/)
    expect(() => createSequenceFolder(r, ['../etc'])).toThrow()
    expect(() => createSequenceFolder(r, [])).toThrow(/at least one/)
  })

  it('save only over a sequence', () => {
    const r = root()
    const t = take(r, '2026-10-15_12-00-00')
    const { folder, sequence } = createSequenceFolder(r, ['2026-10-15_12-00-00'])
    expect(saveSequence(r, folder, { ...sequence, title: 'New' }).title).toBe('New')
    expect(() => saveSequence(r, t, sequence)).toThrow(/Not a sequence/)
  })
})

describe('ffmpeg progress', () => {
  it('reads the last time written', () => {
    expect(parseProgressSeconds('frame=1\nout_time_us=500000\nprogress=continue\nout_time_us=1250000\n')).toBe(1.25)
    expect(parseProgressSeconds('progress=end')).toBeNull()
  })
})

describe('joining rendered clips', () => {
  it('crossfades, cuts, fills silence and matches the first clip’s size', async () => {
    const r = root()
    const folder = path.join(r, '2026-10-15_13-00-00')
    const parts = path.join(folder, SEQUENCE_PARTS_DIR)
    fs.mkdirSync(parts, { recursive: true })
    fs.writeFileSync(
      path.join(folder, SEQUENCE_FILE),
      JSON.stringify({
        version: 1,
        title: 'Test',
        clips: [
          { id: 'a', kind: 'recording', take: 'A', in: 0, out: null, transition: { style: 'dissolve', durationSec: 0.5 } },
          { id: 'b', kind: 'recording', take: 'B', in: 0.5, out: null, transition: { style: 'none', durationSec: 0.5 } },
          { id: 'c', kind: 'recording', take: 'C', in: 0, out: 1.5 }
        ]
      })
    )
    const files = [path.join(parts, '0.mp4'), path.join(parts, '1.mp4'), path.join(parts, '2.mp4')]
    clip(files[0]!, 3, '640x360', true)
    clip(files[1]!, 2.5, '480x480', false)
    clip(files[2]!, 2, '640x360', true)
    const seen: number[] = []
    const out = await joinSequence(r, ffmpeg, { folder, parts: files, name: 'Reel' }, (f) => seen.push(f))
    expect(path.basename(out)).toBe('Reel.mp4')
    expect(fs.existsSync(parts)).toBe(false)
    const p = probe(out)!
    // 3 + (2.5 - 0.5 in) - 0.5 crossfade + 1.5 = 6.0
    expect(p.durationSec).toBeGreaterThan(5.85)
    expect(p.durationSec).toBeLessThan(6.15)
    expect([p.width, p.height]).toEqual([640, 360])
    expect(p.audioCodec).toBe('aac')
    expect(seen.at(-1)).toBe(1)
  }, 60_000)

  it('refuses files that are not this sequence’s clips', async () => {
    const r = root()
    const folder = path.join(r, '2026-10-15_13-00-00')
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, SEQUENCE_FILE), JSON.stringify({ clips: [{ take: 'A' }] }))
    await expect(joinSequence(r, ffmpeg, { folder, parts: ['/etc/passwd'], name: 'x' })).rejects.toThrow(/Not one of/)
  })
})
