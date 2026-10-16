import { describe, expect, it } from 'vitest'
import { GUIDE_STEP_GAP_MS, guideSteps, moveGuide, normalizeGuideSteps, startGuide } from './recording-guide'

const steps = guideSteps([{ action: 'Open Footprint' }, { action: 'Click the biggest folder' }, { action: 'Press Review' }], ['Open Footprint', 'Bigger blocks mean more space'])

describe('guide steps', () => {
  it('pair the shot list with the captions, in order', () => {
    expect(steps).toEqual([
      { action: 'Open Footprint', caption: 'Open Footprint' },
      { action: 'Click the biggest folder', caption: 'Bigger blocks mean more space' },
      { action: 'Press Review' }
    ])
    // More captions than shots: the caption is the step.
    expect(guideSteps([], ['Only a caption'])).toEqual([{ action: 'Only a caption', caption: 'Only a caption' }])
  })

  it('are checked again after crossing IPC', () => {
    expect(normalizeGuideSteps([{ action: '  Go  ', caption: 7 }, null, { caption: 'x' }, 'junk'])).toEqual([{ action: 'Go' }, { action: 'x', caption: 'x' }])
    expect(normalizeGuideSteps('nope')).toEqual([])
  })
})

describe('moving through the guide', () => {
  const g = startGuide(steps)!

  it('moves on with a click, once per burst of presses', () => {
    const a = moveGuide(g, 'click', 3000)
    expect(a).toMatchObject({ index: 1, marks: [3000] })
    expect(moveGuide(a, 'click', 3000 + GUIDE_STEP_GAP_MS - 1)).toBe(a)
    expect(moveGuide(a, 'click', 3000 + GUIDE_STEP_GAP_MS)).toMatchObject({ index: 2, marks: [3000, 4200] })
  })

  it('stops at the last step, and Back takes a step and its mark back', () => {
    let s = moveGuide(moveGuide(g, 'next', 1000), 'next', 1500)
    expect(s.index).toBe(2)
    expect(moveGuide(s, 'click', 9000)).toBe(s)
    s = moveGuide(s, 'back', 9000)
    expect(s).toMatchObject({ index: 1, marks: [1000] })
    expect(moveGuide(g, 'back', 1)).toBe(g)
  })

  it('never puts a mark before the one it follows', () => {
    expect(moveGuide(moveGuide(g, 'next', 5000), 'next', 4000).marks).toEqual([5000, 5000])
  })

  it('needs steps', () => {
    expect(startGuide([])).toBeNull()
  })
})
