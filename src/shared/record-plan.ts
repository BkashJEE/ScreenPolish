/**
 * A recording plan: what an agent proposes before anything is recorded.
 *
 * You say what the video is for; an agent you already use answers with the
 * angle to record, how long, a shot list, the look, and the cards around it.
 * This module builds the question, pulls the plan out of the answer and
 * checks every field, because the answer is a model's text: anything missing
 * or out of range is dropped or clamped here rather than trusted.
 *
 * Pure, so the prompt and the parsing are tested without an agent.
 */

import { normalizeScenes, type Scene } from './scenes'

export type PlanSourceKind = 'screen' | 'window' | 'region'
export type PlanAspect = '16:9' | '9:16' | '1:1' | '4:5' | '4:3'
/** The record panel's pointer styles an agent may pick from. */
export type PlanPointer = 'agent' | 'halo' | 'star' | 'arrow' | 'hand' | 'bobbing' | 'dot'

export interface PlanShot {
  /** Seconds from the start of the recording. */
  atSec: number
  /** What to do on screen at that moment. */
  action: string
}

export interface RecordPlan {
  /** One or two sentences: what this video is and who it is for. */
  summary: string
  source: {
    kind: PlanSourceKind
    /** Which screen or window, by the name it was offered under. */
    target?: string
    /** Why this angle. */
    reason: string
  }
  /** How long the recording itself should run, before cards. */
  durationSec: number
  shots: PlanShot[]
  look: {
    aspect?: PlanAspect
    fps?: 30 | 60
    pointer?: PlanPointer
    mic?: boolean
    systemAudio?: boolean
    /** Two hex colours for a gradient background. */
    background?: [string, string]
  }
  /** Intro and outro cards. */
  scenes: Scene[]
  /** Things to do before pressing Record: close notifications, zoom the browser… */
  prep: string[]
}

export const PLAN_MAX_SEC = 600
export const PLAN_MIN_SEC = 5
export const PLAN_MAX_SHOTS = 20
export const PLAN_MAX_PREP = 8
const MAX_TEXT = 280

const HEX = /^#[0-9a-f]{6}$/i

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

/** A plan from whatever the agent sent, or null when there is no usable plan in it. */
export function normalizePlan(raw: unknown): RecordPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const summary = text(r.summary)
  const src = (r.source && typeof r.source === 'object' ? r.source : {}) as Record<string, unknown>
  const kind = oneOf(src.kind, ['screen', 'window', 'region'] as const)
  const duration = Number(r.durationSec)
  if (!summary || !kind || !Number.isFinite(duration)) return null
  const durationSec = Math.round(Math.min(PLAN_MAX_SEC, Math.max(PLAN_MIN_SEC, duration)))

  const shots = (Array.isArray(r.shots) ? r.shots : [])
    .map((s) => {
      const shot = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
      const at = Number(shot.atSec)
      const action = text(shot.action, 160)
      return Number.isFinite(at) && action ? { atSec: Math.min(durationSec, Math.max(0, Math.round(at * 10) / 10)), action } : null
    })
    .filter((s): s is PlanShot => s !== null)
    .sort((a, b) => a.atSec - b.atSec)
    .slice(0, PLAN_MAX_SHOTS)

  const lookRaw = (r.look && typeof r.look === 'object' ? r.look : {}) as Record<string, unknown>
  const bg = Array.isArray(lookRaw.background) ? lookRaw.background.filter((c): c is string => typeof c === 'string' && HEX.test(c)) : []
  const look: RecordPlan['look'] = {}
  const aspect = oneOf(lookRaw.aspect, ['16:9', '9:16', '1:1', '4:5', '4:3'] as const)
  if (aspect) look.aspect = aspect
  const fps = oneOf(Number(lookRaw.fps), [30, 60] as const)
  if (fps) look.fps = fps
  // `ring` was offered before the lists matched; it was always drawn as the dot.
  const pointer = oneOf(lookRaw.pointer === 'ring' ? 'dot' : lookRaw.pointer, ['agent', 'halo', 'star', 'arrow', 'hand', 'bobbing', 'dot'] as const)
  if (pointer) look.pointer = pointer
  if (typeof lookRaw.mic === 'boolean') look.mic = lookRaw.mic
  if (typeof lookRaw.systemAudio === 'boolean') look.systemAudio = lookRaw.systemAudio
  if (bg.length >= 2) look.background = [bg[0]!, bg[1]!]

  // At most one card each side: a plan is a starting point, not a slideshow.
  const scenes = normalizeScenes(r.scenes)
  const intro = scenes.find((s) => s.kind === 'intro')
  const outro = scenes.find((s) => s.kind === 'outro')

  return {
    summary,
    source: { kind, ...(text(src.target, 120) ? { target: text(src.target, 120) } : {}), reason: text(src.reason) },
    durationSec,
    shots,
    look,
    scenes: [intro, outro].filter((s): s is Scene => s !== undefined),
    prep: (Array.isArray(r.prep) ? r.prep : []).map((p) => text(p, 160)).filter(Boolean).slice(0, PLAN_MAX_PREP)
  }
}

/**
 * The plan out of an agent's reply, and the reply's words without it. Agents
 * answer in prose with the JSON in a fenced block; the last block that parses
 * into a plan wins, so a corrected plan later in the reply replaces the first.
 */
export function extractPlan(reply: string): { plan: RecordPlan | null; message: string } {
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const plan = normalizePlan(JSON.parse(blocks[i]![1]!))
      if (plan) return { plan, message: reply.replace(blocks[i]![0], '').trim() }
    } catch {
      // Not JSON; keep looking.
    }
  }
  // No fence: a bare object somewhere in the reply.
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const plan = normalizePlan(JSON.parse(reply.slice(start, end + 1)))
      if (plan) return { plan, message: (reply.slice(0, start) + reply.slice(end + 1)).trim() }
    } catch {
      // Not a plan.
    }
  }
  return { plan: null, message: reply.trim() }
}

export interface PlanContext {
  /** What can be recorded, by the names the record panel shows. */
  screens: Array<{ name: string; width: number; height: number }>
  windows: string[]
  hasMic: boolean
  hasWebcam: boolean
}

export interface PlanTurn {
  role: 'user' | 'agent'
  text: string
}

const SHAPE = `{
  "summary": "one or two sentences: what the video is and who it is for",
  "source": { "kind": "screen" | "window" | "region", "target": "a screen or window name from the list", "reason": "why this angle" },
  "durationSec": 45,
  "shots": [ { "atSec": 0, "action": "what to do on screen" } ],
  "look": { "aspect": "16:9" | "9:16" | "1:1" | "4:5" | "4:3", "fps": 30 | 60, "pointer": "agent" | "halo" | "star" | "arrow" | "hand" | "bobbing" | "dot", "mic": true, "systemAudio": false, "background": ["#1f2a44", "#6a3d9a"] },
  "scenes": [
    { "kind": "intro", "style": "calm" | "bold", "title": "…", "subtitle": "…", "steps": ["…"], "durationSec": 3 },
    { "kind": "outro", "style": "calm" | "bold", "title": "…", "subtitle": "…", "durationSec": 2.5 }
  ],
  "prep": ["things to do before pressing Record"]
}`

/**
 * The whole question for a one-shot agent call: what ScreenPolish is, what
 * this machine can record, the conversation so far, and the exact shape of
 * the answer. Window titles are included so the agent can pick one; they are
 * the same names the record panel already shows.
 */
export function planPrompt(context: PlanContext, history: readonly PlanTurn[]): string {
  const screens = context.screens.map((s) => `- ${s.name} (${s.width}x${s.height})`).join('\n') || '- (none reported)'
  const windows = context.windows.slice(0, 30).map((w) => `- ${w}`).join('\n') || '- (none reported)'
  const conversation = history.map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`).join('\n\n')
  return `You are helping plan a screen recording in ScreenPolish, a screen recorder that zooms toward every click on its own, draws a clean pointer, frames the take on a background, and can add an animated intro and outro card.

Plan the recording the user describes. Be concrete and brief: pick the angle that keeps the important thing large (a window or region beats a whole ultrawide screen), a length that fits where it will be posted (social clips 15–60 s), a shot list a person can follow while recording, a look, and the cards. Don't use tools; just answer.

What this machine can record:
Screens:
${screens}
Windows:
${windows}
Microphone: ${context.hasMic ? 'available' : 'none'}. Webcam: ${context.hasWebcam ? 'available' : 'none'}.

Conversation so far:
${conversation}

Reply with a short note to the user (two or three sentences), then the plan as JSON in a \`\`\`json fenced block, exactly this shape:
${SHAPE}`
}

/** What a plan sets on the take itself once it is recorded: its cards, background and shape. */
export interface PlanTakeLook {
  scenes: Scene[]
  background?: [string, string]
  aspect?: PlanAspect
}

export function takeLookOf(plan: RecordPlan): PlanTakeLook {
  return {
    scenes: plan.scenes,
    ...(plan.look.background ? { background: plan.look.background } : {}),
    ...(plan.look.aspect ? { aspect: plan.look.aspect } : {})
  }
}

/** A take look from the renderer, checked again here because it crossed IPC. */
export function normalizeTakeLook(raw: unknown): PlanTakeLook | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const bg = Array.isArray(r.background) ? r.background.filter((c): c is string => typeof c === 'string' && HEX.test(c)) : []
  const aspect = oneOf(r.aspect, ['16:9', '9:16', '1:1', '4:5', '4:3'] as const)
  return {
    scenes: normalizeScenes(r.scenes).slice(0, 2),
    ...(bg.length >= 2 ? { background: [bg[0]!, bg[1]!] as [string, string] } : {}),
    ...(aspect ? { aspect } : {})
  }
}
