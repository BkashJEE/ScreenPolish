import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Project, RecordingEvents } from '@shared/types'
import { formatFolderName } from './naming'
import { newRecordingProject } from './new-recording-project'
import { serializeProject } from './project-io'

/**
 * Open a video made elsewhere (OBS, a phone, another recorder) as a recording.
 *
 * A recording is a folder holding screen.mp4 (picture only), the sound beside
 * it, events.json (the input log) and project.json. An imported file has no
 * input log, so its log is empty and says the pointer is already in the
 * picture, which keeps the drawn pointer off. Everything else in the editor
 * works on it as on any take: zooms by hand, cuts, speed, captions, frame,
 * background, export.
 */

/** What the import dialog offers. Chromium plays H.264 MP4; anything else is converted. */
export const IMPORT_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] as const

export interface VideoProbe {
  width: number
  height: number
  durationSec: number
  fps: number
  videoCodec: string
  /** Rotation from the file's display matrix, degrees; phones record sideways and say so here. */
  rotation: number
  audioCodec: string | null
}

/** What ffmpeg says about a file when asked to open it, read into a probe. */
export function parseProbe(info: string): VideoProbe | null {
  const video = /Stream #\S+.*?: Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(info)
  if (!video) return null
  const duration = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(info)
  const fps = /, (\d+(?:\.\d+)?) fps/.exec(info)
  const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(info) ?? /rotate\s*:\s*(-?\d+)/.exec(info)
  const audio = /Stream #\S+.*?: Audio: (\w+)/.exec(info)
  return {
    videoCodec: video[1]!,
    width: Number(video[2]),
    height: Number(video[3]),
    durationSec: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    fps: fps ? Number(fps[1]) : 30,
    rotation: rotation ? Math.round(Number(rotation[1])) : 0,
    audioCodec: audio ? audio[1]! : null
  }
}

/** The picture's size as it plays, after any rotation. */
export function displaySize(p: VideoProbe): { width: number; height: number } {
  const quarter = Math.abs(Math.round(p.rotation / 90)) % 2 === 1
  return quarter ? { width: p.height, height: p.width } : { width: p.width, height: p.height }
}

/**
 * ffmpeg arguments for screen.mp4: copied when it is already H.264 the right
 * way up, otherwise converted (which also applies any rotation). Sound is
 * left out; it goes to its own file.
 */
export function screenArgs(input: string, output: string, p: VideoProbe): string[] {
  const copy = p.videoCodec === 'h264' && p.rotation === 0
  const video = copy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0', '-an', ...video, '-movflags', '+faststart', output]
}

/** ffmpeg arguments for the sound, as AAC in its own file the way a take's system audio is kept. */
export function soundArgs(input: string, output: string, p: VideoProbe): string[] {
  const codec = p.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-vn', ...codec, output]
}

/** The input log for a file with no input: empty, sized to the picture, and saying the pointer is in it. */
export function importedEvents(size: { width: number; height: number }, fileName: string, now = Date.now()): RecordingEvents {
  return {
    version: 1,
    startedAt: now,
    region: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    cursorBaked: true,
    pointer: [],
    clicks: [],
    wheel: [],
    keys: [],
    inputNote: `Opened from ${fileName}. It has no click log, so add zooms by hand on the timeline.`
  }
}

/** A project for the import: the usual new-take defaults, named after the file, at its frame rate. */
export function importedProject(fileName: string, fps: number): Project {
  const project = newRecordingProject({ title: path.basename(fileName, path.extname(fileName)), fps: fps > 45 ? 60 : 30, cursorSkin: 'arrow' })
  return { ...project, zoom: { ...project.zoom, auto: false } }
}

function run(ffmpeg: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }, (error, _stdout, stderr) => {
      resolve({ ok: !error, err: String(stderr ?? '') })
    })
  })
}

/** A folder name in `root` that is free: now, or a second later if a take landed in the same second. */
function freeFolder(root: string, now: Date): string {
  for (let i = 0; i < 60; i++) {
    const dir = path.join(root, formatFolderName(new Date(now.getTime() + i * 1000)))
    if (!fs.existsSync(dir)) return dir
  }
  throw new Error('Could not find a free folder name for the imported video.')
}

/** Import `file` into `root`; resolves with the new recording's folder. */
export async function importVideo(ffmpeg: string, root: string, file: string): Promise<string> {
  const probe = parseProbe((await run(ffmpeg, ['-hide_banner', '-i', file])).err)
  if (!probe) throw new Error(`${path.basename(file)} has no video ScreenPolish can read.`)
  fs.mkdirSync(root, { recursive: true })
  const dir = freeFolder(root, new Date())
  fs.mkdirSync(dir)
  try {
    const screen = await run(ffmpeg, screenArgs(file, path.join(dir, 'screen.mp4'), probe))
    if (!screen.ok) throw new Error(`Could not read the picture from ${path.basename(file)}: ${screen.err.trim().split('\n').at(-1) ?? 'ffmpeg failed'}`)
    if (probe.audioCodec) {
      // A file whose sound cannot be read still opens, silent, rather than not at all.
      const sound = await run(ffmpeg, soundArgs(file, path.join(dir, 'system.mp4'), probe))
      if (!sound.ok) fs.rmSync(path.join(dir, 'system.mp4'), { force: true })
    }
    const size = displaySize(probe)
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(importedEvents(size, path.basename(file))))
    fs.writeFileSync(path.join(dir, 'project.json'), serializeProject(importedProject(file, probe.fps)))
    return dir
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
