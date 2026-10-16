// Automatic zoom planning from the click log, plus resolution of the final
// segment list (auto minus removed, manual on top). Pure, no DOM.
import type { Project, RecordingEvents, ZoomSegment, CameraStyle } from './types'

export interface ZoomPlanConfig {
  /** 'cinematic' alternates zoom, tilt and drift across clusters; 'zoom' keeps them plain. */
  motion: Project['zoom']['motion']
  /** Zoom factor applied to every auto segment. */
  scale: number
  /** Seconds the zoom starts before the first click of a cluster. */
  leadInSec: number
  /** Seconds the zoom lingers after the last click of a cluster. */
  leadOutSec: number
  /** Two clicks belong to the same cluster when this close in time (seconds)... */
  clusterGapSec: number
  /** ...and this close in space (px). Both conditions must hold. */
  clusterDistPx: number
  /** Segments whose gap is smaller than this (seconds) are merged. */
  mergeGapSec: number
  /** Segments shorter than this (seconds) are extended. */
  minSegmentSec: number
  /**
   * Only merge neighbouring zooms whose focus points fit in one zoomed view;
   * the others stay separate and touching, so the camera pans from one click
   * to the next instead of aiming between them and showing neither. Off keeps
   * the older plan, whose `auto-<n>` ids a project's removed zooms refer to.
   */
  keepApart: boolean
}

export const DEFAULT_ZOOM_PLAN: ZoomPlanConfig = {
  motion: 'cinematic',
  scale: 2,
  leadInSec: 0.5,
  leadOutSec: 1.4,
  clusterGapSec: 2.0,
  clusterDistPx: 320,
  mergeGapSec: 0.8,
  minSegmentSec: 1.2,
  keepApart: true
}

interface Click {
  t: number
  x: number
  y: number
}

interface Span {
  start: number
  end: number
  x: number
  y: number
  /** Number of clicks behind this span; used for weighted centroids on merge. */
  weight: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Strip the split suffix (`~n`) that resolveZoomSegments appends when a
 * segment is split by a manual one, so every piece maps back to its plan id.
 */
export function baseSegmentId(id: string): string {
  const i = id.indexOf('~')
  return i === -1 ? id : id.slice(0, i)
}

function clusterClicks(clicks: Click[], cfg: ZoomPlanConfig): Click[][] {
  const clusters: Click[][] = []
  for (const click of clicks) {
    const current = clusters[clusters.length - 1]
    const prev = current?.[current.length - 1]
    if (
      current &&
      prev &&
      click.t - prev.t <= cfg.clusterGapSec &&
      Math.hypot(click.x - (cfg.motion === 'smart' ? current[0].x : prev.x), click.y - (cfg.motion === 'smart' ? current[0].y : prev.y)) <= cfg.clusterDistPx
    ) {
      current.push(click)
    } else {
      clusters.push([click])
    }
  }
  return clusters
}

function spanFromCluster(cluster: Click[], cfg: ZoomPlanConfig, duration: number): Span {
  let sx = 0
  let sy = 0
  for (const c of cluster) {
    sx += c.x
    sy += c.y
  }
  return {
    start: clamp(cluster[0].t - cfg.leadInSec, 0, duration),
    end: clamp(cluster[cluster.length - 1].t + cfg.leadOutSec, 0, duration),
    x: sx / cluster.length,
    y: sy / cluster.length,
    weight: cluster.length
  }
}

/** Share of the zoomed view two focus points may be apart and still share one zoom: each then sits well inside it. */
export const SHARED_VIEW_FRACTION = 0.6

/**
 * Merge sorted spans whose gap is smaller than `gapSec`. Focus = weighted
 * centroid. With `view`, only spans whose foci fit in one zoomed view merge;
 * the rest are trimmed to touch, so the camera pans across without zooming out.
 */
function mergeSpans(spans: Span[], gapSec: number, view?: { width: number; height: number }, minSec = 0): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const s of sorted) {
    const cur = out[out.length - 1]
    const near = cur !== undefined && s.start - cur.end < gapSec
    if (cur && near && view && !(Math.abs(s.x - cur.x) <= view.width * SHARED_VIEW_FRACTION && Math.abs(s.y - cur.y) <= view.height * SHARED_VIEW_FRACTION)) {
      // Too far apart to share a view: keep both, meeting halfway where they overlap,
      // unless that leaves either too short to read (rapid clicks all over), which merges as before.
      const boundary = cur.end > s.start ? Math.max(cur.start, Math.min(s.end, (cur.end + s.start) / 2)) : null
      const curEnd = boundary ?? cur.end
      const nextStart = boundary ?? s.start
      if (curEnd - cur.start >= minSec && s.end - nextStart >= minSec) {
        cur.end = curEnd
        out.push({ ...s, start: nextStart })
        continue
      }
    }
    if (cur && near) {
      const w = cur.weight + s.weight
      cur.x = (cur.x * cur.weight + s.x * s.weight) / w
      cur.y = (cur.y * cur.weight + s.y * s.weight) / w
      cur.weight = w
      cur.end = Math.max(cur.end, s.end)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

/** Grow a span to at least `minSec`, forward first, then backward if the end hits `duration`. */
function extendSpan(span: Span, minSec: number, duration: number): Span {
  const len = span.end - span.start
  if (len >= minSec) return span
  const need = minSec - len
  let end = span.end + need
  let start = span.start
  if (end > duration) {
    start -= end - duration
    end = duration
  }
  return { ...span, start: Math.max(0, start), end }
}

/**
 * Plan auto zoom segments from mousedown clicks.
 *
 * Clicks are clustered (same cluster when within `clusterGapSec` AND
 * `clusterDistPx` of the previous click). Each cluster becomes a segment from
 * first click - leadIn to last click + leadOut focused on the cluster centroid,
 * clamped to [0, durationSec]. Segments closer than `mergeGapSec` are merged
 * (weighted centroid), segments shorter than `minSegmentSec` are extended.
 * Result is sorted and non-overlapping. Ids are `auto-<index>`, so for the
 * same events and config the ids are stable across recomputes.
 */
export function planAutoZoom(
  events: RecordingEvents,
  durationSec: number,
  cfg: Partial<ZoomPlanConfig> = {}
): ZoomSegment[] {
  const c: ZoomPlanConfig = { ...DEFAULT_ZOOM_PLAN, ...cfg }
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0
  if (duration <= 0) return []

  const regionWidth = events.region?.width ?? 0
  const regionHeight = events.region?.height ?? 0
  const clicks: Click[] = events.clicks
    .filter(
      (k) =>
        k.down &&
        Number.isFinite(k.t) &&
        Number.isFinite(k.x) &&
        Number.isFinite(k.y) &&
        k.x >= 0 &&
        k.y >= 0 &&
        (regionWidth <= 0 || k.x < regionWidth) &&
        (regionHeight <= 0 || k.y < regionHeight)
    )
    .map((k) => ({ t: k.t / 1000, x: k.x, y: k.y }))
    .sort((a, b) => a.t - b.t)
  if (clicks.length === 0) return []

  let spans = clusterClicks(clicks, c)
    .map((cluster) => spanFromCluster(cluster, c, duration))
    .filter((s) => s.end > s.start)
  if (c.motion === 'smart') {
    // Preserve new-area focus targets instead of merging them into a midpoint.
    // Touching segments use cameraAt's existing smooth target-to-target pan.
    for (let i = 1; i < spans.length; i++) {
      const previous = spans[i - 1]
      const next = spans[i]
      if (previous.end > next.start) {
        const boundary = Math.max(previous.start, Math.min(next.end, (previous.end + next.start) / 2))
        previous.end = boundary
        next.start = boundary
      }
    }
    spans = spans.filter((s) => s.end > s.start)
  } else {
    // The part of the picture one zoom shows; without a region size every merge is allowed, as before.
    const view = c.keepApart && regionWidth > 0 && regionHeight > 0 ? { width: regionWidth / Math.max(c.scale, 1), height: regionHeight / Math.max(c.scale, 1) } : undefined
    spans = mergeSpans(spans, c.mergeGapSec, view, c.minSegmentSec)
    spans = spans.map((s) => extendSpan(s, c.minSegmentSec, duration))
    // Extension can close gaps or create overlaps; merge once more.
    spans = mergeSpans(spans, c.mergeGapSec, view, c.minSegmentSec)
  }

  return spans.map((s, i) => ({
    id: `auto-${i}`,
    start: s.start,
    end: s.end,
    x: s.x,
    y: s.y,
    scale: c.scale,
    source: 'auto' as const,
    style: autoStyle(i, s.x, regionWidth, c.motion)
  }))
}

/**
 * Style for the i-th automatic cluster. Cinematic motion cycles zoom, tilt,
 * drift, so a recording never tilts the same way twice in a row; the tilt
 * brings the side the click is on toward the viewer.
 */
export function autoStyle(index: number, focusX: number, regionWidth: number, motion: Project['zoom']['motion']): CameraStyle {
  if (motion === 'punch') return 'punch'
  if (motion !== 'cinematic') return 'zoom'
  switch (index % 6) {
    case 1:
      return regionWidth > 0 && focusX < regionWidth / 2 ? 'tilt-left' : 'tilt-right'
    case 2:
      return 'drift'
    case 4:
      return regionWidth > 0 && focusX < regionWidth / 2 ? 'tilt-right' : 'tilt-left'
    case 5:
      return 'orbit'
    default:
      return 'zoom'
  }
}

/** Remove the part of `seg` covered by `cutter`; returns 0, 1 or 2 pieces. */
function subtract(seg: ZoomSegment, cutter: ZoomSegment): ZoomSegment[] {
  if (cutter.end <= seg.start || cutter.start >= seg.end) return [seg]
  const pieces: ZoomSegment[] = []
  if (seg.start < cutter.start) pieces.push({ ...seg, end: cutter.start })
  if (seg.end > cutter.end) pieces.push({ ...seg, start: cutter.end })
  return pieces
}

function subtractAll(segments: ZoomSegment[], cutter: ZoomSegment): ZoomSegment[] {
  return segments.flatMap((s) => subtract(s, cutter))
}

/** Give every piece of a split segment a unique id: `id`, `id~2`, `id~3`, ... */
function uniqueIds(segments: ZoomSegment[]): ZoomSegment[] {
  const seen = new Map<string, number>()
  return segments.map((s) => {
    const n = (seen.get(s.id) ?? 0) + 1
    seen.set(s.id, n)
    return n === 1 ? s : { ...s, id: `${s.id}~${n}` }
  })
}

/**
 * Final segment list for rendering.
 *
 * - `[]` when zoom is disabled.
 * - Auto segments (when `zoom.auto`) at `zoom.scale`, minus ids listed in
 *   `zoom.removedAuto` (split suffixes are ignored when matching, so removing
 *   any piece removes the whole auto segment).
 * - Manual segments overlay auto ones: where they overlap the auto segment is
 *   clipped or split so the manual wins. Later manual entries win over earlier
 *   ones. Split pieces get `~n` suffixed ids (see baseSegmentId).
 * - Everything clamped to [0, durationSec], sorted, non-overlapping.
 */
export function resolveZoomSegments(
  project: Project,
  events: RecordingEvents,
  durationSec: number
): ZoomSegment[] {
  const zoom = project.zoom
  if (!zoom.enabled) return []
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0

  const removed = new Set(zoom.removedAuto.map(baseSegmentId))
  let auto: ZoomSegment[] = zoom.auto
    ? // A project that removed automatic zooms keeps the plan its removals were made against.
      planAutoZoom(events, duration, { scale: zoom.scale, motion: zoom.motion ?? 'cinematic', keepApart: removed.size === 0 }).filter((s) => !removed.has(s.id))
    : []

  let manual: ZoomSegment[] = []
  for (const m of zoom.manual) {
    const s: ZoomSegment = {
      ...m,
      start: clamp(m.start, 0, duration),
      end: clamp(m.end, 0, duration),
      source: 'manual'
    }
    if (!(s.end > s.start)) continue
    manual = [...subtractAll(manual, s), s]
    auto = subtractAll(auto, s)
  }

  const all = [...auto, ...manual]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  return uniqueIds(all)
}
