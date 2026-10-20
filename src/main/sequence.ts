import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SEQUENCE_FILE, createSequence, normalizeSequence, placeClips, type PlacedClip, type Sequence } from '@shared/sequence'
import { assertInsideRoot } from './export-sink'
import { parseProbe, type VideoProbe } from './import-video'
import { formatFolderName, sanitizeBaseName, uniqueName } from './naming'

/**
 * Sequences on disk, and the last step of their export.
 *
 * A sequence lives in its own folder under the recordings root, named like a
 * take so it sorts with them, holding sequence.json. Its export renders each
 * clip with the ordinary per-take exporter into `parts/` (the editor does
 * that, as for any take), then joins the parts here with ffmpeg: plain
 * concatenation for hard cuts, xfade and acrossfade for crossfades. Every part
 * is scaled to the first one's size and frame rate, so takes recorded at
 * different shapes still join.
 */

export const SEQUENCE_PARTS_DIR = 'parts'

export function isSequenceFolder(folder: string): boolean {
  return fs.existsSync(path.join(folder, SEQUENCE_FILE))
}

/** A take a sequence can use: a recording folder under the root with a picture in it. */
function takeFolder(root: string, take: string): string {
  if (!take || take.includes('/') || take.includes('\\') || take === '.' || take === '..') throw new Error(`Not a recording: ${take}`)
  const folder = assertInsideRoot(root, path.join(root, take))
  if (!fs.existsSync(path.join(folder, 'screen.mp4'))) throw new Error(`${take} is not a recording in ${root}`)
  return folder
}

/** A folder name in `root` that is free: now, or a second later if a take landed in the same second. */
function freeFolder(root: string, now: Date): string {
  for (let i = 0; i < 60; i++) {
    const dir = path.join(root, formatFolderName(new Date(now.getTime() + i * 1000)))
    if (!fs.existsSync(dir)) return dir
  }
  throw new Error('Could not find a free folder name for the sequence.')
}

/** Make a sequence of `takes` (folder names or paths inside `root`) and return its folder. */
export function createSequenceFolder(root: string, takes: readonly string[], title = '', now = new Date()): { folder: string; sequence: Sequence } {
  const names = takes.map((t) => path.basename(path.resolve(root, t)))
  if (names.length === 0) throw new Error('A sequence needs at least one take.')
  for (const name of names) takeFolder(root, name)
  fs.mkdirSync(root, { recursive: true })
  const folder = freeFolder(root, now)
  fs.mkdirSync(folder)
  const sequence = createSequence(names, title)
  writeSequence(folder, sequence)
  return { folder, sequence }
}

export function readSequence(root: string, folder: string): Sequence {
  const abs = assertInsideRoot(root, folder)
  return normalizeSequence(JSON.parse(fs.readFileSync(path.join(abs, SEQUENCE_FILE), 'utf8')))
}

function writeSequence(folder: string, sequence: Sequence): void {
  const target = path.join(folder, SEQUENCE_FILE)
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(normalizeSequence(sequence), null, 2))
  fs.renameSync(`${target}.tmp`, target)
}

export function saveSequence(root: string, folder: string, sequence: Sequence): Sequence {
  const abs = assertInsideRoot(root, folder)
  if (!isSequenceFolder(abs)) throw new Error(`Not a sequence: ${folder}`)
  const clean = normalizeSequence(sequence)
  writeSequence(abs, clean)
  return clean
}

/** Each clip's take folder, in clip order; throws naming the first missing one. */
export function sequenceTakeFolders(root: string, sequence: Sequence): string[] {
  return sequence.clips.map((c) => takeFolder(root, c.take))
}

// ---------------------------------------------------------------------------
// Join

export interface JoinPart {
  file: string
  probe: VideoProbe
}

/**
 * ffmpeg arguments that cut each part to its clip and join them. `placed`
 * comes from placeClips over the parts' own lengths; `size` and `fps` are the
 * finished video's.
 */
export function sequenceJoinArgs(parts: readonly JoinPart[], placed: readonly PlacedClip[], size: { width: number; height: number }, fps: number, output: string): string[] {
  const w = Math.max(2, Math.round(size.width / 2) * 2)
  const h = Math.max(2, Math.round(size.height / 2) * 2)
  const f = (n: number) => n.toFixed(4)
  const graph: string[] = []
  parts.forEach((part, i) => {
    const p = placed[i]!
    const len = p.out - p.in
    graph.push(
      `[${i}:v]trim=start=${f(p.in)}:end=${f(p.out)},setpts=PTS-STARTPTS,fps=${fps},` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB[v${i}]`
    )
    graph.push(
      part.probe.audioCodec
        ? `[${i}:a]atrim=start=${f(p.in)}:end=${f(p.out)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        : // A part with no sound still needs a track, or the joins would shift the sound of the others.
          `anullsrc=r=48000:cl=stereo,atrim=duration=${f(len)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
    )
  })
  let v = 'v0'
  let a = 'a0'
  let length = placed[0] ? placed[0].out - placed[0].in : 0
  for (let i = 1; i < parts.length; i++) {
    const p = placed[i]!
    const overlap = placed[i - 1]!.overlapNext
    const len = p.out - p.in
    if (overlap > 0) {
      graph.push(`[${v}][v${i}]xfade=transition=fade:duration=${f(overlap)}:offset=${f(Math.max(0, length - overlap))}[vx${i}]`)
      graph.push(`[${a}][a${i}]acrossfade=d=${f(overlap)}[ax${i}]`)
      length += len - overlap
    } else {
      graph.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[vx${i}][ax${i}]`)
      length += len
    }
    v = `vx${i}`
    a = `ax${i}`
  }
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    ...parts.flatMap((p) => ['-i', p.file]),
    '-filter_complex', graph.join(';'),
    '-map', `[${v}]`, '-map', `[${a}]`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output
  ]
}

/** Seconds of output ffmpeg reports having written, from its `-progress` stream. */
export function parseProgressSeconds(chunk: string): number | null {
  const all = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)]
  const last = all.at(-1)
  return last ? Number(last[1]) / 1e6 : null
}

function probe(ffmpeg: string, file: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, _out, stderr) => {
      const p = parseProbe(String(stderr ?? ''))
      if (p) resolve(p)
      else reject(new Error(`Could not read ${path.basename(file)}`))
    })
  })
}

export interface JoinRequest {
  /** The sequence folder. */
  folder: string
  /** The rendered clips in sequence order, each a file in the sequence's parts folder. */
  parts: string[]
  /** Base name of the finished file. */
  name: string
}

/**
 * Join the rendered clips of the sequence in `folder` into one MP4 in its
 * exports folder, reporting 0..1 as ffmpeg goes. The parts are deleted once
 * the result is in place.
 */
export async function joinSequence(root: string, ffmpeg: string, req: JoinRequest, onProgress: (f: number) => void = () => undefined): Promise<string> {
  const folder = assertInsideRoot(root, req.folder)
  const sequence = readSequence(root, folder)
  const partsDir = path.join(folder, SEQUENCE_PARTS_DIR)
  if (req.parts.length !== sequence.clips.length) throw new Error(`Expected ${sequence.clips.length} rendered clips, got ${req.parts.length}.`)
  const files = req.parts.map((p) => {
    const abs = path.resolve(p)
    if (path.dirname(abs) !== partsDir) throw new Error(`Not one of this sequence's clips: ${p}`)
    return abs
  })
  const parts = await Promise.all(files.map(async (file) => ({ file, probe: await probe(ffmpeg, file) })))
  const placed = placeClips(sequence, parts.map((p) => p.probe.durationSec))
  const total = placed.at(-1)?.end ?? 0
  if (!(total > 0)) throw new Error('Nothing to export: every clip is empty.')

  const exportsDir = path.join(folder, 'exports')
  await fs.promises.mkdir(exportsDir, { recursive: true })
  const existing = await fs.promises.readdir(exportsDir)
  const finalPath = path.join(exportsDir, uniqueName(existing, sanitizeBaseName(req.name), 'mp4'))
  const writePath = `${finalPath}.joining.mp4`
  const first = parts[0]!.probe
  const args = sequenceJoinArgs(parts, placed, { width: first.width, height: first.height }, Math.round(first.fps) || 30, writePath)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      const sec = parseProgressSeconds(String(d))
      if (sec !== null) onProgress(Math.min(1, sec / total))
    })
    child.stderr.on('data', (d: Buffer) => (err = (err + String(d)).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Joining the clips failed: ${err.trim().split(/\r?\n/).slice(-4).join(' ') || `ffmpeg exited ${code}`}`))))
  }).catch(async (e) => {
    await fs.promises.rm(writePath, { force: true })
    throw e
  })
  await fs.promises.rename(writePath, finalPath)
  await fs.promises.rm(partsDir, { recursive: true, force: true })
  onProgress(1)
  return finalPath
}
