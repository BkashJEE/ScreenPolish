import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '../../shared/ipc'
import type { RecordPlan } from '../../shared/record-plan'
import { applyPlan, matchSource, planContextFrom } from './plan-apply'

const sources: SourceInfo[] = [
  { id: 'screen:1:0', name: 'Primary display (3440×1440)', kind: 'screen', bounds: { x: 0, y: 0, width: 2752, height: 1152 }, scaleFactor: 1.25 },
  { id: 'screen:2:0', name: 'Laptop', kind: 'screen', bounds: { x: 2752, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 'hypr:0xaa', name: 'Firefox — GitHub', kind: 'window' },
  { id: 'hypr:0xbb', name: 'ScreenPolish', kind: 'window' },
  { id: 'hypr:0xcc', name: 'ScreenPolish — Settings', kind: 'window' }
] as SourceInfo[]

function plan(overrides: Partial<RecordPlan> = {}): RecordPlan {
  return { summary: 's', source: { kind: 'screen', reason: '' }, durationSec: 30, shots: [], look: {}, scenes: [], captions: [], prep: [], ...overrides }
}

const current = { mic: '', system: true, fps: 30 as const }

describe('matchSource', () => {
  it('prefers an exact name, then the most specific partial one', () => {
    const windows = sources.filter((s) => s.kind === 'window')
    expect(matchSource('screenpolish', windows)?.id).toBe('hypr:0xbb')
    expect(matchSource('Firefox', windows)?.id).toBe('hypr:0xaa')
    expect(matchSource('Slack', windows)).toBeUndefined()
    expect(matchSource(undefined, windows)).toBeUndefined()
  })
})

describe('applyPlan', () => {
  it('picks the planned window', () => {
    const r = applyPlan(plan({ source: { kind: 'window', target: 'ScreenPolish', reason: '' } }), sources, current)
    expect(r.selection).toEqual({ kind: 'window', sourceId: 'hypr:0xbb' })
    expect(r.notes).toEqual([])
  })

  it('falls back to the screen and says why when the window is not open', () => {
    const r = applyPlan(plan({ source: { kind: 'window', target: 'Slack', reason: '' } }), sources, current)
    expect(r.selection).toEqual({ kind: 'screen', displayId: 1 })
    expect(r.notes[0]).toContain('No open window matches "Slack"')
  })

  it('picks a named screen, or a region on it', () => {
    expect(applyPlan(plan({ source: { kind: 'screen', target: 'Laptop', reason: '' } }), sources, current).selection).toEqual({ kind: 'screen', displayId: 2 })
    expect(applyPlan(plan({ source: { kind: 'region', reason: '' } }), sources, current).selection).toEqual({ kind: 'region', displayId: 1 })
  })

  it('sets the inputs the plan names and keeps the rest', () => {
    const on = applyPlan(plan({ look: { mic: true, fps: 60, systemAudio: false, pointer: 'hand' } }), sources, current)
    expect(on.choices).toEqual({ mic: 'auto', system: false, fps: 60 })
    expect(on.cursorSkin).toBe('hand')
    // A chosen microphone is kept rather than replaced with "first device".
    expect(applyPlan(plan({ look: { mic: true } }), sources, { ...current, mic: 'usb-mic' }).choices.mic).toBe('usb-mic')
    expect(applyPlan(plan({ look: { mic: false } }), sources, { ...current, mic: 'usb-mic' }).choices.mic).toBe('')
    expect(applyPlan(plan(), sources, current)).toMatchObject({ choices: current })
  })
})

describe('planContextFrom', () => {
  it('tells the agent the physical sizes and the window names', () => {
    const ctx = planContextFrom(sources, true, false)
    expect(ctx.screens[0]).toEqual({ name: 'Primary display (3440×1440)', width: 3440, height: 1440 })
    expect(ctx.windows).toEqual(['Firefox — GitHub', 'ScreenPolish', 'ScreenPolish — Settings'])
    expect(ctx).toMatchObject({ hasMic: true, hasWebcam: false })
  })
})
