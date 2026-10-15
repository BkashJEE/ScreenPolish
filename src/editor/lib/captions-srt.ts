import { cuesToSrt, normalizeCaptions } from '../../shared/captions'
import { effectiveTrim } from '../../shared/layout'
import { sceneTimeline } from '../../shared/scenes'
import { outputTimeAt, speedSpans } from '../../shared/speed'
import type { Project } from '../../shared/types'

/**
 * The project's captions as a .srt file timed to its export: trims, cuts and
 * speed changes are applied, and an intro card pushes everything later.
 */
export function projectSrt(project: Project, durationSec: number): string {
  const trim = effectiveTrim(project, durationSec)
  const spans = speedSpans(trim.start, trim.end, project.speedRegions, project.cuts)
  const recordingSec = spans.at(-1)?.outputEnd ?? 0
  const introSec = sceneTimeline(project.scenes ?? [], recordingSec).introSec
  return cuesToSrt(normalizeCaptions(project.captions).cues, (t) => introSec + outputTimeAt(t, spans))
}
