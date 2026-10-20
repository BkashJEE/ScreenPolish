// Receives export bytes from the editor and writes them under
// <recording>/exports/. GIF exports land in a temp MP4 first, then ffmpeg
// (two-pass palette) produces the .gif and the temp file is removed.

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExportBeginRequest, ExportBeginResponse, ExportEndRequest, ExportEndResponse } from '@shared/ipc'
import { ffmpegGifArgs } from './gif'
import { audioMixFilter, hasSpeedChange, spansEnd, speedMixPassOneArgs, speedMixPassTwoArgs } from './audio-filter'
import { sanitizeBaseName, stemOf, uniqueName } from './naming'
import { mixVoiceover } from './voiceover'

export interface ExportSinkDeps {
  /** Recordings root; export folders must live under it. */
  root: () => string
  ffmpegPath: () => string
  /** fraction 0..1, or null when the export ended or was aborted. */
  onProgress?: (exportId: string, fraction: number | null) => void
}

export interface ExportSink {
  begin(request: ExportBeginRequest): Promise<ExportBeginResponse>
  chunk(exportId: string, position: number, data: ArrayBuffer | ArrayBufferView): void
  end(request: ExportEndRequest): Promise<ExportEndResponse>
  abort(exportId: string): Promise<void>
  progress(exportId: string, fraction: number): void
  /** Whether any export is being written right now. */
  busy(): boolean
}

interface Job {
  id: string
  kind: 'mp4' | 'gif'
  fd: number | null
  /** File currently being written (the MP4, or the temp MP4 for GIF). */
  writePath: string
  finalPath: string
  /** The take's folder, where its voiceover files are. */
  folder: string
}

let counter = 0

/**
 * Extension an in-progress export writes under. It is deliberately not a media
 * extension, so a half-written file cannot be mistaken for a finished one by
 * the library, a file manager, or the person looking at the folder.
 */
export const PART_SUFFIX = '.part'

/** Older than this and a part file cannot belong to a running export. */
const ABANDONED_PART_MS = 6 * 60 * 60 * 1000

/**
 * Clear part files left by an export that was killed rather than finished -
 * a crash, a quit, or the machine going down mid-render. Only old ones, so a
 * second export running right now is never touched.
 */
async function sweepAbandonedParts(dir: string, existing: readonly string[]): Promise<void> {
  const now = Date.now()
  await Promise.all(
    existing
      .filter((name) => name.endsWith(PART_SUFFIX))
      .map(async (name) => {
        const file = path.join(dir, name)
        try {
          const stat = await fs.promises.stat(file)
          if (now - stat.mtimeMs > ABANDONED_PART_MS) await fs.promises.rm(file, { force: true })
        } catch {
          // Gone already, or not ours to read.
        }
      })
  )
}

/**
 * The name to finish under. It was chosen when the export began, and another
 * export may have taken it since - nothing was holding it, because writing
 * went to a part file.
 */
async function claimFinalPath(wanted: string, kind: 'mp4' | 'gif'): Promise<string> {
  if (!fs.existsSync(wanted)) return wanted
  const dir = path.dirname(wanted)
  const existing = await fs.promises.readdir(dir).catch(() => [] as string[])
  return path.join(dir, uniqueName(existing, stemOf(path.basename(wanted)), kind))
}

export function assertInsideRoot(root: string, folder: string): string {
  const rootAbs = path.resolve(root)
  const abs = path.resolve(folder)
  if (!abs.startsWith(rootAbs + path.sep)) throw new Error(`Folder is outside the recordings root: ${folder}`)
  return abs
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const tail = String(stderr ?? '').trim().split(/\r?\n/).slice(-6).join('\n')
      reject(new Error(`ffmpeg failed: ${error.message}${tail ? `\n${tail}` : ''}`))
    })
  })
}

export function createExportSink(deps: ExportSinkDeps): ExportSink {
  const jobs = new Map<string, Job>()

  const take = (id: string): Job => {
    const job = jobs.get(id)
    if (!job) throw new Error(`Unknown export ${id}`)
    return job
  }

  const closeFd = (job: Job): void => {
    if (job.fd === null) return
    try {
      fs.closeSync(job.fd)
    } catch (err) {
      console.warn('[export] close failed', err)
    }
    job.fd = null
  }

  return {
    busy: () => jobs.size > 0,
    async begin(request) {
      const folder = assertInsideRoot(deps.root(), request.folder)
      const exportsDir = request.into ? assertInsideRoot(deps.root(), request.into) : path.join(folder, 'exports')
      await fs.promises.mkdir(exportsDir, { recursive: true })
      const existing = await fs.promises.readdir(exportsDir)
      const base = sanitizeBaseName(request.name)
      const id = `exp-${Date.now()}-${++counter}`
      const finalName = uniqueName(existing, base, request.kind)
      const finalPath = path.join(exportsDir, finalName)
      // Never write to the name the user will see. An export that dies before
      // it finishes used to leave a plausible-looking 0 byte .mp4 sitting in
      // the folder, indistinguishable from a real one until it was played.
      const writePath = request.kind === 'gif'
        ? path.join(exportsDir, `${stemOf(finalName)}.${id}.tmp.mp4`)
        : `${finalPath}.${id}${PART_SUFFIX}`
      await sweepAbandonedParts(exportsDir, existing)
      const fd = fs.openSync(writePath, 'w+')
      jobs.set(id, { id, kind: request.kind, fd, writePath, finalPath, folder })
      deps.onProgress?.(id, 0)
      return { exportId: id, path: writePath }
    },

    chunk(exportId, position, data) {
      const job = take(exportId)
      if (job.fd === null) throw new Error(`Export ${exportId} is already closed`)
      const buf = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
      let offset = 0
      while (offset < buf.length) {
        offset += fs.writeSync(job.fd, buf, offset, buf.length - offset, position + offset)
      }
    },

    async end(request) {
      const job = take(request.exportId)
      closeFd(job)
      try {
        // A render that produced nothing is a failure, not a file. Saying so
        // here is the difference between an error the user can act on and an
        // empty export they discover later.
        const written = await fs.promises.stat(job.writePath).then((st) => st.size).catch(() => 0)
        if (written === 0) {
          await fs.promises.rm(job.writePath, { force: true })
          throw new Error('The export produced no video, so nothing was saved. Try again, and tell us if it keeps happening.')
        }
        const count = request.audioTrackCount ?? 0
        if (job.kind === 'mp4' && Number.isInteger(count) && count >= 1 && count <= 32) {
          const mixed = `${job.writePath}.${job.id}.mixed.mp4`
          const spans = request.audioSpeedSpans
          if (spans && hasSpeedChange(spans)) {
            // Speed changes: mix to one WAV, then correct pitch piece by piece.
            const wav = `${job.writePath}.${job.id}.mix.wav`
            try {
              await runFfmpeg(deps.ffmpegPath(), speedMixPassOneArgs(job.writePath, count, request.durationSec ?? spansEnd(spans), wav))
              await runFfmpeg(deps.ffmpegPath(), speedMixPassTwoArgs(job.writePath, wav, spans, mixed))
            } finally {
              await fs.promises.rm(wav, { force: true })
            }
          } else {
            await runFfmpeg(deps.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', job.writePath, '-filter_complex', audioMixFilter(count, request.durationSec), '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', mixed])
          }
          await fs.promises.rename(mixed, job.writePath)
        }
        // The voiceover goes in last, on the output clock, after every speed and pitch step.
        if (job.kind === 'mp4' && request.voiceover?.length) {
          await mixVoiceover(deps.ffmpegPath(), job.writePath, job.folder, request.voiceover, {
            hasAudio: Number.isInteger(count) && count >= 1,
            durationSec: request.durationSec ?? 0,
            duck: request.duckUnderVoice !== false
          })
        }
        if (job.kind === 'gif') {
          await runFfmpeg(deps.ffmpegPath(), ffmpegGifArgs(job.writePath, job.finalPath, request.fps, request.width, request.loop))
          await fs.promises.rm(job.writePath, { force: true })
        } else {
          // Only now does the finished file take the name the library shows.
          job.finalPath = await claimFinalPath(job.finalPath, job.kind)
          await fs.promises.rename(job.writePath, job.finalPath)
        }
      } finally {
        jobs.delete(job.id)
        deps.onProgress?.(job.id, null)
      }
      return { path: job.finalPath }
    },

    async abort(exportId) {
      const job = jobs.get(exportId)
      if (!job) return
      closeFd(job)
      jobs.delete(job.id)
      deps.onProgress?.(job.id, null)
      await fs.promises.rm(job.writePath, { force: true })
      if (job.finalPath !== job.writePath) await fs.promises.rm(job.finalPath, { force: true })
    },

    progress(exportId, fraction) {
      if (!jobs.has(exportId)) return
      const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
      deps.onProgress?.(exportId, f)
    }
  }
}
