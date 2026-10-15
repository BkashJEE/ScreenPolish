import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { MIN_ACTIVE_PER_SEC, findTyping, typingRanges } from './typing'

const ffmpeg = typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic) ? ffmpegStatic : null
const still = { pointer: [[0, 100, 100], [12000, 100, 100]] as Array<[number, number, number]>, clicks: [] }

describe('typingRanges', () => {
  const fps = 10
  const px = 320 * 180
  // 2 s still, 4 s of letters on 7 frames in 10, 4 s of a caret blinking twice a second, 2 s of scrolling.
  const changes = [
    ...Array(20).fill(0),
    ...Array.from({ length: 40 }, (_, i) => (i % 10 < 7 ? 12 : 0)),
    ...Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 8 : 0)),
    ...Array(20).fill(px * 0.3)
  ]

  it('finds letters appearing, and not a blinking caret or scrolling', () => {
    const ranges = typingRanges(changes, fps, px, still)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.start).toBeGreaterThanOrEqual(1.4)
    expect(ranges[0]!.start).toBeLessThanOrEqual(2.6)
    expect(ranges[0]!.end).toBeGreaterThanOrEqual(5.4)
    expect(ranges[0]!.end).toBeLessThanOrEqual(6.6)
  })

  it('needs the pointer to rest and nothing to be clicked', () => {
    const moving = { pointer: Array.from({ length: 120 }, (_, i) => [i * 100, i * 20, 100] as [number, number, number]), clicks: [] }
    expect(typingRanges(changes, fps, px, moving)).toEqual([])
    const clicking = { ...still, clicks: Array.from({ length: 8 }, (_, i) => ({ t: 2000 + i * 500, x: 0, y: 0, button: 'left' as const, down: true })) }
    expect(typingRanges(changes, fps, px, clicking)).toEqual([])
  })

  it('ignores stretches too short to be worth speeding up', () => {
    const short = [...Array(10).fill(0), ...Array(8).fill(12), ...Array(20).fill(0)]
    expect(typingRanges(short, fps, px, still)).toEqual([])
    expect(MIN_ACTIVE_PER_SEC).toBeGreaterThan(2)
  })
})

describe.skipIf(!ffmpeg)('findTyping on a real video', () => {
  it('finds the typing in an encoded recording', async () => {
    const W = 320, H = 180, fps = 10
    const frames: Buffer[] = []
    const base = () => Buffer.alloc(W * H, 30)
    let typed = 0
    for (let i = 0; i < 120; i++) {
      const f = base()
      const t = i / fps
      if (t >= 2) {
        if (t < 6 && i % 10 < 7) typed++
        // Letters typed so far, as small bright blocks along a line.
        for (let k = 0; k < typed; k++) for (let y = 60; y < 68; y++) for (let x = 0; x < 4; x++) f[y * W + 20 + k * 6 + x] = 220
      }
      if (t >= 6 && t < 10 && Math.floor(i / 5) % 2 === 0) for (let y = 80; y < 90; y++) f[y * W + 200] = 230
      if (t >= 10) for (let p = 0; p < f.length; p++) f[p] = ((p + i * 37) % 97) * 2
      frames.push(f)
    }
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-typing-'))
    const video = path.join(dir, 'screen.mp4')
    const r = spawnSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', video], { input: Buffer.concat(frames) })
    expect(r.status).toBe(0)
    const ranges = await findTyping(ffmpeg!, video, still)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.start).toBeLessThan(2.8)
    expect(ranges[0]!.end).toBeGreaterThan(5.2)
    expect(ranges[0]!.end).toBeLessThan(6.8)
  }, 60_000)
})
