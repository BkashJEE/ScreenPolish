import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { displaySize, importVideo, importedEvents, importedProject, parseProbe, screenArgs, soundArgs } from './import-video'

const ffmpeg = typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic) ? ffmpegStatic : null

const OBS = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'take.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 4000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 3800 kb/s, 60 fps, 60 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 160 kb/s (default)`

const PHONE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Duration: 00:00:09.03, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 8000 kb/s, 29.97 fps, 30 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: pcm_s16le (sowt / 0x74776F73), 44100 Hz, mono, s16, 705 kb/s (default)`

describe('parseProbe', () => {
  it('reads size, length, frame rate and codecs', () => {
    expect(parseProbe(OBS)).toEqual({ videoCodec: 'h264', width: 1920, height: 1080, durationSec: 62.5, fps: 60, rotation: 0, audioCodec: 'aac' })
  })

  it("reads a phone video's rotation, and plays it the right way up", () => {
    const p = parseProbe(PHONE)!
    expect(p).toMatchObject({ videoCodec: 'hevc', rotation: -90, audioCodec: 'pcm_s16le', fps: 29.97 })
    expect(displaySize(p)).toEqual({ width: 1080, height: 1920 })
  })

  it('is null for something with no picture', () => {
    expect(parseProbe('Input #0, wav, from a.wav:\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz')).toBeNull()
  })
})

describe('import arguments', () => {
  it('copies H.264 that is the right way up and converts anything else', () => {
    expect(screenArgs('a', 'b', parseProbe(OBS)!)).toEqual(expect.arrayContaining(['-c:v', 'copy', '-an']))
    const phone = screenArgs('a', 'b', parseProbe(PHONE)!)
    expect(phone).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an']))
  })

  it('keeps AAC sound as it is and converts other sound to AAC', () => {
    expect(soundArgs('a', 'b', parseProbe(OBS)!)).toEqual(expect.arrayContaining(['-c:a', 'copy', '-vn']))
    expect(soundArgs('a', 'b', parseProbe(PHONE)!)).toEqual(expect.arrayContaining(['-c:a', 'aac']))
  })

  it('writes an empty input log that keeps the drawn pointer off, and a project named after the file', () => {
    const e = importedEvents({ width: 1080, height: 1920 }, 'IMG_0001.MOV', 5)
    expect(e).toMatchObject({ startedAt: 5, cursorBaked: true, pointer: [], clicks: [], region: { width: 1080, height: 1920, scale: 1 } })
    expect(e.inputNote).toContain('IMG_0001.MOV')
    const p = importedProject('/videos/My demo.mov', 59.94)
    expect(p.title).toBe('My demo')
    expect(p.output.fps).toBe(60)
    expect(p.zoom.auto).toBe(false)
  })
})

describe.skipIf(!ffmpeg)('importVideo with real ffmpeg', () => {
  const make = (args: string[]) => execFileSync(ffmpeg!, ['-v', 'error', '-y', ...args])
  const codecOf = (file: string) => /Video: (\w+)/.exec(String(spawnSync(ffmpeg!, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr))?.[1]

  it('converts a non-H.264 video with sound into a recording the editor can open', async () => {
    const work = fs.mkdtempSync(path.join(tmpdir(), 'sp-import-'))
    const src = path.join(work, 'clip.avi')
    make(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', src])
    const root = path.join(work, 'Recordings')
    const dir = await importVideo(ffmpeg!, root, src)
    expect(path.dirname(dir)).toBe(root)
    expect(fs.readdirSync(dir).sort()).toEqual(['events.json', 'project.json', 'screen.mp4', 'system.mp4'])
    expect(codecOf(path.join(dir, 'screen.mp4'))).toBe('h264')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).region).toMatchObject({ width: 320, height: 180 })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).title).toBe('clip')
  }, 60_000)

  it('copies a silent H.264 video without converting it, and leaves no sound file', async () => {
    const work = fs.mkdtempSync(path.join(tmpdir(), 'sp-import-'))
    const src = path.join(work, 'screen-capture.mp4')
    make(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src])
    const dir = await importVideo(ffmpeg!, path.join(work, 'Recordings'), src)
    expect(fs.readdirSync(dir).sort()).toEqual(['events.json', 'project.json', 'screen.mp4'])
    expect(codecOf(path.join(dir, 'screen.mp4'))).toBe('h264')
  }, 60_000)

  it('leaves nothing behind when the file is not a video', async () => {
    const work = fs.mkdtempSync(path.join(tmpdir(), 'sp-import-'))
    const src = path.join(work, 'notes.mp4')
    fs.writeFileSync(src, 'not a video')
    const root = path.join(work, 'Recordings')
    await expect(importVideo(ffmpeg!, root, src)).rejects.toThrow('no video')
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })
})
