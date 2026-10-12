// The project.json a freshly finished recording starts with.
//
// Separate from DEFAULT_PROJECT on purpose: DEFAULT_PROJECT also fills gaps in
// older saved projects, so turning something on there would change recordings
// that were already made. Choices here only apply to new takes.

import { DEFAULT_PROJECT, type Project } from '@shared/types'
import { DEFAULT_CLICK_SOUND } from '@shared/click-sound'
import { DEFAULT_ZOOM_SOUND } from '@shared/zoom-sound'
import type { PlanTakeLook } from '@shared/record-plan'

/**
 * `look`, when given, is what a recording plan chose for this take: its intro
 * and outro cards, a gradient background and the output shape.
 */
export function newRecordingProject(args: { title: string; fps: 30 | 60; cursorSkin: string; look?: PlanTakeLook | null }): Project {
  const skin = args.cursorSkin
  const style = skin === 'agent' || skin === 'halo' || skin === 'star' ? skin : skin === 'sprite' ? 'sprite' : skin === 'hand' ? 'hand' : skin === 'dot' || skin === 'ring' ? 'dot' : 'arrow'
  const look = args.look
  const intro = look?.scenes.find((sc) => sc.kind === 'intro')
  return {
    ...DEFAULT_PROJECT,
    // A planned take is named by its intro card rather than the window it caught.
    title: intro?.title || args.title,
    output: { ...DEFAULT_PROJECT.output, fps: args.fps, ...(look?.aspect ? { aspect: look.aspect } : {}) },
    ...(look?.background ? { background: { kind: 'gradient' as const, colors: [...look.background], angle: 135 } } : {}),
    scenes: look?.scenes ?? [],
    // New recordings get a soft whoosh under each zoom; turn it off per project under Zoom.
    zoom: { ...DEFAULT_PROJECT.zoom, sound: { ...DEFAULT_ZOOM_SOUND, enabled: true } },
    // New recordings tick on every mouse press, and glide fast pointer moves; both per project under Cursor.
    cursor: { ...DEFAULT_PROJECT.cursor, style, glide: 0.5, clickSound: { ...DEFAULT_CLICK_SOUND, enabled: true } }
  }
}
