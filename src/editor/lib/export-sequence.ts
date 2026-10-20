import type { LoadedSequence } from '../../shared/ipc'
import { syncEvents } from '../../shared/input-sync'
import type { Project } from '../../shared/types'
import { exportProject } from './export'
import { normalizeProject } from './project'
import { withCleanVoice } from './voice'

/** Share of the progress bar the renders take; joining them is the rest. */
const RENDER_SHARE = 0.85

export interface SequenceExportArgs {
  loaded: LoadedSequence
  name: string
  onProgress: (fraction: number, label: string) => void
  signal: AbortSignal
}

/**
 * Export a sequence: render each clip's take with the ordinary per-take
 * exporter into the sequence's parts folder, exactly as that take exports on
 * its own (same look, zooms, captions, cards), then have main cut and join
 * the parts. Every take renders at the first take's shape, size and frame
 * rate, so the parts join without letterboxing.
 */
export async function exportSequence({ loaded, name, onProgress, signal }: SequenceExportArgs): Promise<{ path: string }> {
  const { sequence, takes, partsDir } = loaded
  if (sequence.clips.length === 0) throw new Error('This sequence has no clips.')
  const missing = takes.find((t) => t.missing)
  if (missing) throw new Error(`${missing.take} is no longer in the recordings folder.`)

  let shape: Project['output'] | null = null
  const parts: string[] = []
  // Each take is rendered once, even if several clips cut from it.
  const rendered = new Map<string, string>()
  const share = RENDER_SHARE / sequence.clips.length
  for (const [i, clip] of sequence.clips.entries()) {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
    const label = `Rendering ${i + 1} of ${sequence.clips.length}`
    const done = rendered.get(clip.take)
    if (done) {
      parts.push(done)
      onProgress(share * (i + 1), label)
      continue
    }
    const take = await window.polish.load(takes[i]!.folder)
    const project = normalizeProject(take.project)
    shape ??= project.output
    const r = await exportProject({
      folder: take.files.folder,
      urls: withCleanVoice(project, take.urls, take.urls.micClean),
      events: syncEvents(take.events, project.cursor.syncSec),
      project: { ...project, output: { ...project.output, aspect: shape.aspect, height: shape.height, fps: shape.fps } },
      kind: 'mp4',
      name: `clip-${i + 1}`,
      into: partsDir,
      onProgress: (f) => onProgress(share * (i + f), label),
      signal
    })
    rendered.set(clip.take, r.path)
    parts.push(r.path)
  }

  onProgress(RENDER_SHARE, 'Joining')
  const off = window.polish.onSequenceJoinProgress((f) => onProgress(RENDER_SHARE + (1 - RENDER_SHARE) * f, 'Joining'))
  try {
    const path = await window.polish.sequenceJoin({ folder: loaded.folder, parts, name })
    onProgress(1, 'Done')
    return { path }
  } finally {
    off()
  }
}
