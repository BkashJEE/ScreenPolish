import { effectiveTrim } from './layout'
import { exportDurationSec, exportFrameAt, sceneTimeline, type ExportFrame } from './scenes'
import { outputTimeAt, sourceTimeAt, speedSpans } from './speed'
import type { Project } from './types'

/**
 * A take's own output clock: the seconds its export runs for (intro cards,
 * then the recording after its trim, cuts and speed, then outro cards), and
 * how a moment on it maps back to the recording. Sequences place clips on
 * this clock, so a clip cut from a take matches that take's export exactly.
 */
export function takeOutput(project: Project, sourceDurationSec: number) {
  const trim = effectiveTrim(project, sourceDurationSec)
  const spans = speedSpans(trim.start, trim.end, project.speedRegions, project.cuts)
  const recordingSec = spans.at(-1)?.outputEnd ?? 0
  const timeline = sceneTimeline(project.scenes ?? [], recordingSec)
  return {
    /** Seconds the take's export runs. */
    lengthSec: exportDurationSec(timeline, recordingSec),
    /** What output second `t` shows: a card, or the recording at a source time. */
    at(t: number): ExportFrame | { kind: 'recording'; recordingSec: number; sourceSec: number } {
      const frame = exportFrameAt(timeline, recordingSec, t)
      return frame.kind === 'scene' ? frame : { ...frame, sourceSec: sourceTimeAt(frame.recordingSec, spans) }
    },
    /** The output second showing source time `sourceSec` of the recording. */
    fromSource(sourceSec: number): number {
      return timeline.introSec + outputTimeAt(sourceSec, spans)
    }
  }
}
