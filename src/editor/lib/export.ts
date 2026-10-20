// Export pipeline. Runs inside the editor window because WebCodecs is a
// renderer API. Decodes screen.mp4 (and webcam/mic/system when present) with
// mediabunny, renders every output frame with the same renderFrame the preview
// uses, encodes H264 + AAC and muxes into an MP4 whose bytes stream to main
// through window.polish.exportChunk. GIF = the same MP4 at 15 fps, which main
// converts with ffmpeg in exportEnd.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  type InputAudioTrack,
  type StreamTargetChunk,
  type WrappedCanvas
} from 'mediabunny'
import type { LoadedProject } from '../../shared/ipc'
import type { Project, RecordingEvents } from '../../shared/types'
import { effectiveTrim, outputSize } from '../../shared/layout'
import { speedSpans, sourceTimeAt } from '../../shared/speed'
import { CLICK_SAMPLE_RATE, DEFAULT_CLICK_SOUND, clickRuns, clickTimes } from '../../shared/click-sound'
import { ZOOM_SAMPLE_RATE, audibleZoomTransitions, zoomSoundRuns, zoomTransitions } from '../../shared/zoom-sound'
import { pointerPathFor } from '../../shared/pointer'
import { resolveZoomSegments } from '../../shared/zoom-planner'
import { renderFrame } from '../../render/render-frame'
import { drawScene } from '../../render/scene'
import { exportDurationSec, exportFrameAt, sceneTimeline, spansWithScenes } from '../../shared/scenes'
import { drawCutTransition, holdFrame } from '../../render/cut-transition'
import { cutJoins, cutTransitionActive, normalizeCutTransition, transitionProgress } from '../../shared/cut-transition'
import { gifFps, gifWidth, pickBitrate } from './bitrate'
import { throttle } from './debounce'
import { loadImage, loadOverlayImages } from './media'
import { imageUrlForPath } from './project'

export interface ExportArgs {
  folder: string
  urls: LoadedProject['urls']
  events: RecordingEvents
  project: Project
  kind: 'mp4' | 'gif'
  name: string
  onProgress: (fraction: number) => void
  signal: AbortSignal
  /** Already-decoded background image (the editor has one loaded); loaded from the path otherwise. */
  backgroundImage?: CanvasImageSource | null
  /** Already-decoded image overlays keyed by path; loaded from the paths otherwise. */
  overlayImages?: Map<string, CanvasImageSource>
  /** Folder to write into instead of the recording's exports folder (a sequence's clips). */
  into?: string
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelled()
}

/** exportChunk wants a standalone ArrayBuffer; the StreamTarget hands us views into a pool. */
function standalone(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function openInput(url: string): Input {
  return new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
}

/** Yield start + n/fps for n in [0, count). */
function* frameTimes(start: number, fps: number, count: number): Generator<number> {
  for (let n = 0; n < count; n += 1) yield start + n / fps
}

/**
 * Clip an audio sample to [start, end) and shift it so `start` becomes 0.
 * Returns null when the sample lies wholly outside the range. The returned
 * sample is always a fresh object the caller owns (and must close).
 */
export function clipAudioSample(sample: AudioSample, start: number, end: number): AudioSample | null {
  const sStart = sample.timestamp
  const sEnd = sample.timestamp + sample.duration
  if (sEnd <= start || sStart >= end) return null
  const rate = sample.sampleRate
  const frames = sample.numberOfFrames
  const skip = sStart < start ? Math.min(frames, Math.round((start - sStart) * rate)) : 0
  const keepEnd = sEnd > end ? Math.max(skip, frames - Math.round((sEnd - end) * rate)) : frames
  if (keepEnd - skip <= 0) return null
  const out = skip === 0 && keepEnd === frames ? sample.clone() : sample.trim(skip, keepEnd)
  out.setTimestamp(Math.max(0, out.timestamp - start))
  return out
}

interface AudioJob {
  key: string
  regionStart?: number
  regionEnd?: number
  offset?: number
  /** Decoded (or synthesized) samples overlapping [start, end) in the job's own time. */
  samples: (start: number, end: number) => AsyncIterable<AudioSample>
  source: AudioSampleSource
  gain: number
}

/** One decoder per track, reused for every timeline span. */
function sinkSamples(track: InputAudioTrack): AudioJob['samples'] {
  const sink = new AudioSampleSink(track)
  return (start, end) => sink.samples(start, end)
}

/** Synthesized sounds (clicks, zoom whooshes) as stereo samples, one per mixed run, in source time. */
export async function* clickSoundSamples(runs: ReadonlyArray<{ start: number; samples: Float32Array }>, start: number, end: number, sampleRate = CLICK_SAMPLE_RATE): AsyncGenerator<AudioSample> {
  for (const run of runs) {
    const runEnd = run.start + run.samples.length / sampleRate
    if (runEnd <= start || run.start >= end) continue
    const data = new Float32Array(run.samples.length * 2)
    for (let i = 0; i < run.samples.length; i++) {
      data[i * 2] = run.samples[i]
      data[i * 2 + 1] = run.samples[i]
    }
    yield new AudioSample({ data, format: 'f32', numberOfChannels: 2, sampleRate, timestamp: run.start })
  }
}

/** Return a fresh interleaved float sample with gain applied and clipped safely. */
export function scaleAudioSample(sample: AudioSample, gain: number): AudioSample {
  const data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / Float32Array.BYTES_PER_ELEMENT)
  sample.copyTo(data, { planeIndex: 0, format: 'f32' })
  const safeGain = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 1
  for (let i = 0; i < data.length; i += 1) data[i] = Math.max(-1, Math.min(1, data[i] * safeGain))
  return new AudioSample({
    data,
    format: 'f32',
    numberOfChannels: sample.numberOfChannels,
    sampleRate: sample.sampleRate,
    timestamp: sample.timestamp
  })
}

/** Resample at a timeline speed. Pitch changes intentionally, matching preview. */
export function retimeAudioSample(sample: AudioSample, rate: number, timestamp: number): AudioSample {
  const channels = sample.numberOfChannels
  const input = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / 4)
  sample.copyTo(input, { planeIndex: 0, format: 'f32' })
  const frames = Math.max(1, Math.round(sample.numberOfFrames / rate))
  const data = new Float32Array(frames * channels)
  for (let frame = 0; frame < frames; frame++) {
    const pos = Math.min(sample.numberOfFrames - 1, frame * rate)
    const low = Math.floor(pos)
    const high = Math.min(sample.numberOfFrames - 1, low + 1)
    for (let ch = 0; ch < channels; ch++) data[frame * channels + ch] = input[low * channels + ch] * (1 - (pos - low)) + input[high * channels + ch] * (pos - low)
  }
  return new AudioSample({ data, format: 'f32', numberOfChannels: channels, sampleRate: sample.sampleRate, timestamp })
}

/**
 * The hardware H264 encoder can be unavailable (NVENC session limit while
 * another capture runs, driver hiccup), and WebCodecs then rejects the whole
 * configuration. Try hardware H264, software H264, then VP9, and report which
 * one the export used instead of failing.
 */
export type VideoEncodingChoice = { codec: 'avc' | 'vp9'; hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference'; bitrate: number }

/**
 * H.264 level for a frame size and rate, as the hex byte in the codec string.
 * A level too low for the frame is rejected outright: 1440p and 4K were
 * falling back to VP9 because the string always claimed level 4.0.
 */
export function avcLevel(width: number, height: number, fps: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const rate = macroblocks * Math.max(1, fps)
  // Level: max macroblocks per frame / per second (H.264 Annex A).
  const levels: Array<{ hex: string; frame: number; rate: number }> = [
    { hex: '28', frame: 8192, rate: 245760 },    // 4.0: 1080p30
    { hex: '2a', frame: 8704, rate: 522240 },    // 4.2: 1080p60
    { hex: '32', frame: 22080, rate: 589824 },   // 5.0: 1440p30
    { hex: '33', frame: 36864, rate: 983040 },   // 5.1: 4K30
    { hex: '34', frame: 36864, rate: 2073600 },  // 5.2: 4K60
    { hex: '3c', frame: 139264, rate: 4177920 }  // 6.0: beyond 4K
  ]
  return (levels.find((l) => macroblocks <= l.frame && rate <= l.rate) ?? levels[levels.length - 1]).hex
}

export async function pickVideoEncoding(width: number, height: number, bitrate: number, fps: number): Promise<VideoEncodingChoice> {
  const high = `avc1.6400${avcLevel(width, height, fps)}`
  const baseline = `avc1.4200${avcLevel(width, height, fps)}`
  const candidates: Array<{ choice: VideoEncodingChoice; webcodec: string }> = [
    { choice: { codec: 'avc', hardwareAcceleration: 'prefer-hardware', bitrate }, webcodec: high },
    { choice: { codec: 'avc', hardwareAcceleration: 'prefer-software', bitrate }, webcodec: high },
    { choice: { codec: 'avc', hardwareAcceleration: 'no-preference', bitrate }, webcodec: baseline },
    { choice: { codec: 'vp9', hardwareAcceleration: 'no-preference', bitrate }, webcodec: 'vp09.00.10.08' }
  ]
  if (typeof VideoEncoder === 'undefined') return candidates[0].choice
  for (const c of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.webcodec, width, height, bitrate, framerate: fps, hardwareAcceleration: c.choice.hardwareAcceleration })
      if (r.supported) {
        if (c !== candidates[0]) console.warn(`[export] hardware H264 unavailable, using ${c.choice.codec} (${c.choice.hardwareAcceleration})`)
        return c.choice
      }
    } catch {
      // try the next one
    }
  }
  return candidates[0].choice
}

export async function exportProject(args: ExportArgs): Promise<{ path: string }> {
  const { signal, project, events } = args
  throwIfAborted(signal)

  const inputs: Input[] = []
  let exportId: string | null = null
  let output: Output | null = null
  const onAbort = () => inputs.forEach((i) => i.dispose())
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    const screenInput = openInput(args.urls.screen)
    inputs.push(screenInput)
    const videoTrack = await screenInput.getPrimaryVideoTrack()
    if (!videoTrack) throw new Error('screen.mp4 has no video track')
    if (!(await videoTrack.canDecode())) throw new Error('This machine cannot decode the recording (H264 decoder missing)')

    const duration = await screenInput.computeDuration()
    const { start, end } = effectiveTrim(project, duration)
    const timeline = speedSpans(start, end, project.speedRegions, project.cuts)
    const span = timeline.at(-1)?.outputEnd ?? 0
    if (!(span > 0.01)) throw new Error('Nothing to export: every clip in the trim range is removed')
    // Intro cards play before the recording and outro cards after it; the
    // recording keeps its own clock, `span` long, starting introSec in.
    const scenes = sceneTimeline(project.scenes ?? [], span)

    const quality = project.output.quality ?? 'balanced'
    const fps = args.kind === 'gif' ? gifFps(quality, project.output.gif?.fps) : project.output.fps
    const videoSize = { width: events.region.width, height: events.region.height }
    const size = outputSize(project, videoSize)
    const segments = resolveZoomSegments(project, events, duration)
    const pointerPath = pointerPathFor(events, project.cursor)
    const backgroundImage =
      args.backgroundImage ??
      (project.background.kind === 'image' && project.background.imagePath
        ? await loadImage(imageUrlForPath(project.background.imagePath)).catch(() => null)
        : null)
    const overlays = project.overlays ?? []
    const overlayImages = args.overlayImages ?? (overlays.some((o) => o.kind === 'image') ? await loadOverlayImages(overlays) : new Map<string, CanvasImageSource>())

    // Audio inputs are opened before exportBegin so a decode problem surfaces before main creates a file.
    const audioJobs: AudioJob[] = []
    const masterVolume = project.audio.masterVolume ?? 1
    const wanted: Array<['mic' | 'system', boolean, string | undefined, number]> = [
      ['mic', project.audio.mic, args.urls.mic, (project.audio.micVolume ?? 1) * masterVolume],
      ['system', project.audio.system, args.urls.system, (project.audio.systemVolume ?? 1) * masterVolume]
    ]
    for (const [key, enabled, url, gain] of wanted) {
      if (!enabled || !url) continue
      const input = openInput(url)
      inputs.push(input)
      const track = await input.getPrimaryAudioTrack()
      if (!track || !(await track.canDecode())) continue
      audioJobs.push({ key, samples: sinkSamples(track), source: new AudioSampleSource({ codec: 'pcm-s16' }), gain })
    }

    // Click sounds ride the same timeline as every other track, so trim, removed clips
    // and speed regions (including pitch preservation) apply to them identically.
    const clickSettings = project.cursor.clickSound ?? DEFAULT_CLICK_SOUND
    const runs = clickRuns(clickTimes(events, { start, end }, project.cuts), clickSettings)
    if (runs.length > 0) {
      audioJobs.push({ key: 'clicks', samples: (s, e) => clickSoundSamples(runs, s, e), source: new AudioSampleSource({ codec: 'pcm-s16' }), gain: masterVolume })
    }
    // Zoom whooshes use the same timeline, placed where the camera starts each move.
    const easeSec = project.zoom.easeSec ?? 0.6
    const zoomRuns = zoomSoundRuns(audibleZoomTransitions(zoomTransitions(segments, easeSec), { start, end }, project.cuts), easeSec, project.zoom.sound ?? { enabled: false, volume: 0 })
    if (zoomRuns.length > 0) {
      audioJobs.push({ key: 'zoom-sounds', samples: (s, e) => clickSoundSamples(zoomRuns, s, e, ZOOM_SAMPLE_RATE), source: new AudioSampleSource({ codec: 'pcm-s16' }), gain: masterVolume })
    }

    let webcamSink: CanvasSink | null = null
    for (const region of project.audioRegions ?? []) {
      const input = openInput(imageUrlForPath(region.path))
      inputs.push(input)
      const track = await input.getPrimaryAudioTrack()
      if (!track || !(await track.canDecode())) throw new Error(`Cannot decode audio: ${region.path}`)
      audioJobs.push({ key: region.id, samples: sinkSamples(track), source: new AudioSampleSource({ codec: 'pcm-s16' }), gain: region.volume * masterVolume, regionStart: region.start, regionEnd: region.end, offset: region.offset })
    }
    if (project.webcam.enabled && args.urls.webcam) {
      const input = openInput(args.urls.webcam)
      inputs.push(input)
      const track = await input.getPrimaryVideoTrack()
      if (track && (await track.canDecode())) webcamSink = new CanvasSink(track, { poolSize: 2 })
    }
    throwIfAborted(signal)

    const begin = await window.polish.exportBegin({ folder: args.folder, kind: args.kind, name: args.name, ...(args.into ? { into: args.into } : {}) })
    exportId = begin.exportId
    const id = exportId

    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => window.polish.exportChunk(id, chunk.position, standalone(chunk.data))
    })
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1 << 20 })
    })

    const canvas = new OffscreenCanvas(size.width, size.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a 2D context for export')
    const encoding = await pickVideoEncoding(size.width, size.height, pickBitrate(size.height, quality, fps, size.width), fps)
    const videoSource = new CanvasSource(canvas, {
      codec: encoding.codec,
      bitrate: encoding.bitrate,
      hardwareAcceleration: encoding.hardwareAcceleration,
      keyFrameInterval: 2,
      latencyMode: 'quality'
    })
    output.addVideoTrack(videoSource, { frameRate: fps })
    for (const job of audioJobs) output.addAudioTrack(job.source)

    await output.start()

    const reportToMain = throttle((f: number) => window.polish.exportProgress(id, f), 250)
    const report = (f: number) => {
      const clamped = Math.max(0, Math.min(1, f))
      args.onProgress(clamped)
      reportToMain(clamped)
    }

    // Video: one output frame per 1/fps. Recording frames are pulled from the
    // decoder at exactly their source times; scene frames are drawn instead.
    const frameCount = Math.max(1, Math.round(exportDurationSec(scenes, span) * fps))
    const plan = Array.from({ length: frameCount }, (_, n) => exportFrameAt(scenes, span, n / fps))
    const blank = new OffscreenCanvas(Math.max(1, videoSize.width), Math.max(1, videoSize.height))
    // Where a removed clip joined two pieces, and what covers that join.
    const transition = normalizeCutTransition(project.cutTransition)
    const joins = cutTransitionActive(transition) ? cutJoins(timeline) : []
    const videoJob = (async () => {
      const screenSink = new CanvasSink(videoTrack, { poolSize: 2 })
      const timestamps = () => plan.flatMap((f) => (f.kind === 'recording' ? [sourceTimeAt(f.recordingSec, timeline)] : []))
      const screenIter = screenSink.canvasesAtTimestamps(timestamps())
      const webcamIter = webcamSink ? webcamSink.canvasesAtTimestamps(timestamps()) : null
      let nextJoin = 0
      let held: CanvasImageSource | null = null
      for (let n = 0; n < frameCount; n++) {
        throwIfAborted(signal)
        const outputTime = n / fps
        const frame = plan[n]!
        if (frame.kind === 'scene') {
          drawScene(ctx, size, project, frame.scene, frame.localSec, backgroundImage)
        } else {
          // Joins are on the recording's own clock, not the video's.
          const recordingTime = frame.recordingSec
          const t = sourceTimeAt(recordingTime, timeline)
          // The canvas still holds the frame before the join, so copy it now,
          // before this frame — the first one after the jump — overwrites it.
          while (nextJoin < joins.length && recordingTime >= joins[nextJoin]) {
            held = holdFrame(ctx) ?? held
            nextJoin += 1
          }
          const wrapped = (await screenIter.next()).value ?? null
          let webcam: WrappedCanvas | null = null
          if (webcamIter) webcam = (await webcamIter.next()).value ?? null
          renderFrame(ctx, {
            video: wrapped?.canvas ?? blank,
            videoSize,
            tSec: t,
            events,
            project,
            segments,
            pointerPath,
            webcam: webcam?.canvas ?? null,
            backgroundImage,
            overlays,
            overlayImages,
            duration
          })
          if (held) {
            const progress = transitionProgress(recordingTime, joins, transition)
            if (progress === null) held = null
            else drawCutTransition(ctx, held, progress, transition.style)
          }
        }
        await videoSource.add(outputTime, 1 / fps)
        report(((n + 1) / frameCount) * 0.97)
      }
      await screenIter.return(undefined)
      if (webcamIter) await webcamIter.return(undefined)
    })()

    // Audio: decoded samples clipped to the trim, shifted so the trim start is t=0.
    let audioTrackCount = 0
    const audioWork = audioJobs.map(async (job) => {
      let wroteSamples = false
      for (const piece of timeline) {
      const lo = Math.max(piece.start, job.regionStart ?? 0)
      const hi = Math.min(piece.end, job.regionEnd ?? end)
      if (hi <= lo) continue
      const fileStart = lo - (job.regionStart ?? 0) + (job.offset ?? 0)
      const fileEnd = hi - (job.regionStart ?? 0) + (job.offset ?? 0)
      for await (const sample of job.samples(fileStart, fileEnd)) {
        throwIfAborted(signal)
        const clipped = clipAudioSample(sample, fileStart, fileEnd)
        sample.close()
        if (!clipped) continue
        const scaled = scaleAudioSample(clipped, job.gain)
        clipped.close()
        const retimed = retimeAudioSample(scaled, piece.rate, scenes.introSec + piece.outputStart + (lo - piece.start + scaled.timestamp) / piece.rate)
        try {
          await job.source.add(retimed)
          if (!wroteSamples) { wroteSamples = true; audioTrackCount++ }
        }
        finally { retimed.close(); scaled.close() }
      }
      }
    })

    await Promise.all([videoJob, ...audioWork])
    throwIfAborted(signal)

    await output.finalize()
    report(0.99)
    const done = await window.polish.exportEnd({
      exportId: id,
      audioTrackCount,
      durationSec: frameCount / fps,
      audioSpeedSpans: project.preserveAudioPitch !== false ? spansWithScenes(timeline.map(span => ({start:span.outputStart,end:span.outputEnd,rate:span.rate})), scenes) : undefined,
      fps: args.kind === 'gif' ? gifFps(quality, project.output.gif?.fps) : undefined,
      width: args.kind === 'gif' ? gifWidth(size.width, quality, project.output.gif?.width) : undefined,
      loop: args.kind === 'gif' ? project.output.gif?.loop !== false : undefined,
      ...(args.kind === 'mp4' && project.voiceover?.length
        ? { voiceover: project.voiceover.map((v) => ({ file: v.file, atSec: v.atSec, volume: v.volume * (project.audio.masterVolume ?? 1) })), duckUnderVoice: project.audio.duckUnderVoice !== false }
        : {})
    })
    report(1)
    return { path: done.path }
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    if (exportId) await window.polish.exportAbort(exportId).catch(() => undefined)
    if (signal.aborted) throw new ExportCancelled()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    inputs.forEach((i) => i.dispose())
  }
}
