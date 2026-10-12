import { describe, expect, it } from 'vitest'
import { PLAN_MAX_SEC, PLAN_MAX_SHOTS, PLAN_MIN_SEC, extractPlan, normalizePlan, planPrompt } from './record-plan'

const good = {
  summary: 'A 45-second walkthrough of exporting a GIF, for X.',
  source: { kind: 'window', target: 'ScreenPolish', reason: 'Keeps the editor large on an ultrawide screen.' },
  durationSec: 45,
  shots: [
    { atSec: 12, action: 'Open the export sheet' },
    { atSec: 0, action: 'Show the library' }
  ],
  look: { aspect: '16:9', fps: 60, pointer: 'hand', mic: true, systemAudio: false, background: ['#1f2a44', '#6a3d9a'] },
  scenes: [
    { kind: 'intro', style: 'bold', title: 'Export a GIF', steps: ['Open', 'Pick GIF', 'Export'], durationSec: 3 },
    { kind: 'outro', style: 'calm', title: 'Thanks for watching', durationSec: 2.5 }
  ],
  prep: ['Turn on Do Not Disturb']
}

describe('normalizePlan', () => {
  it('keeps a well-formed plan, with shots in time order', () => {
    const plan = normalizePlan(good)!
    expect(plan.source).toEqual(good.source)
    expect(plan.durationSec).toBe(45)
    expect(plan.shots.map((s) => s.atSec)).toEqual([0, 12])
    expect(plan.look).toEqual(good.look)
    expect(plan.scenes.map((s) => s.kind)).toEqual(['intro', 'outro'])
    expect(plan.prep).toEqual(['Turn on Do Not Disturb'])
  })

  it('refuses a plan without its essentials', () => {
    expect(normalizePlan(null)).toBeNull()
    expect(normalizePlan({ ...good, summary: '' })).toBeNull()
    expect(normalizePlan({ ...good, source: { kind: 'monitor' } })).toBeNull()
    expect(normalizePlan({ ...good, durationSec: 'a while' })).toBeNull()
  })

  it('clamps and drops what a model got wrong', () => {
    const plan = normalizePlan({
      ...good,
      durationSec: 99999,
      shots: [...Array.from({ length: 30 }, (_, i) => ({ atSec: i, action: `step ${i}` })), { atSec: 'soon', action: 'x' }, { atSec: 5000, action: 'late' }],
      look: { aspect: '4:3', fps: 24, pointer: 'laser', mic: 'yes', background: ['red', '#00ff00'] },
      scenes: [{ kind: 'intro', title: 'One' }, { kind: 'intro', title: 'Two' }, { kind: 'outro', title: '' }]
    })!
    expect(plan.durationSec).toBe(PLAN_MAX_SEC)
    expect(plan.shots).toHaveLength(PLAN_MAX_SHOTS)
    expect(plan.look).toEqual({})
    expect(plan.scenes.map((s) => s.title)).toEqual(['One'])
    expect(normalizePlan({ ...good, durationSec: 1 })!.durationSec).toBe(PLAN_MIN_SEC)
  })

  it('offers the editor\'s pointers, and reads the old ring as the dot', () => {
    for (const pointer of ['agent', 'halo', 'star', 'arrow', 'hand', 'bobbing', 'dot']) {
      expect(normalizePlan({ ...good, look: { pointer } })!.look.pointer).toBe(pointer)
    }
    expect(normalizePlan({ ...good, look: { pointer: 'ring' } })!.look.pointer).toBe('dot')
  })

  it('keeps shot times inside the recording', () => {
    const plan = normalizePlan({ ...good, durationSec: 20, shots: [{ atSec: 90, action: 'end' }, { atSec: -3, action: 'start' }] })!
    expect(plan.shots).toEqual([{ atSec: 0, action: 'start' }, { atSec: 20, action: 'end' }])
  })
})

describe('extractPlan', () => {
  it('takes the plan from a fenced block and keeps the note', () => {
    const reply = `Here's a tight cut for X.\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nShout if you want it shorter.`
    const { plan, message } = extractPlan(reply)
    expect(plan?.durationSec).toBe(45)
    expect(message).toBe("Here's a tight cut for X.\n\n\nShout if you want it shorter.")
  })

  it('prefers the last plan when the agent corrected itself', () => {
    const reply = `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nActually shorter:\n\`\`\`json\n${JSON.stringify({ ...good, durationSec: 20 })}\n\`\`\``
    expect(extractPlan(reply).plan?.durationSec).toBe(20)
  })

  it('finds a bare object, and says so when there is no plan at all', () => {
    expect(extractPlan(`Sure: ${JSON.stringify(good)}`).plan?.summary).toBe(good.summary)
    expect(extractPlan('What platform is this for?')).toEqual({ plan: null, message: 'What platform is this for?' })
    expect(extractPlan('```json\n{ not json\n```').plan).toBeNull()
  })
})

describe('planPrompt', () => {
  const context = { screens: [{ name: 'Primary display', width: 3440, height: 1440 }], windows: ['Firefox — Docs', 'ScreenPolish'], hasMic: true, hasWebcam: false }

  it('tells the agent what can be recorded and what shape to answer in', () => {
    const prompt = planPrompt(context, [{ role: 'user', text: 'A demo of exporting a GIF for X' }])
    expect(prompt).toContain('Primary display (3440x1440)')
    expect(prompt).toContain('- Firefox — Docs')
    expect(prompt).toContain('Microphone: available. Webcam: none.')
    expect(prompt).toContain('User: A demo of exporting a GIF for X')
    expect(prompt).toContain('"durationSec"')
    expect(prompt).toContain("Don't use tools")
  })

  it('carries the conversation, so a follow-up refines the same plan', () => {
    const prompt = planPrompt(context, [
      { role: 'user', text: 'Demo for X' },
      { role: 'agent', text: 'A 45 s window recording.' },
      { role: 'user', text: 'Make it shorter' }
    ])
    expect(prompt.indexOf('User: Demo for X')).toBeLessThan(prompt.indexOf('You: A 45 s window recording.'))
    expect(prompt.indexOf('You: A 45 s window recording.')).toBeLessThan(prompt.indexOf('User: Make it shorter'))
  })
})
