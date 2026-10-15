import { describe, expect, it } from 'vitest'
import type { Ctx2D } from '../shared/ctx2d'
import type { CaptionSettings, CaptionWord } from '../shared/captions'
import { BOLD_MAX_WORDS, boldChunk, drawCaptions, layoutWords } from './captions'

const measure = (s: string) => s.length * 10
const words = (texts: string[]): CaptionWord[] => texts.map((text, i) => ({ text, start: i, end: i + 1 }))

describe('layoutWords', () => {
  it('centres each line and wraps at the width, numbering words from the first given', () => {
    const lines = layoutWords(words(['aaaa', 'bb', 'cccc']), 5, 80, 2, measure, 100)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.map((p) => p.index)).toEqual([5, 6])
    // "aaaa bb" is 70 wide, centred on 100.
    expect(lines[0]![0]!.x).toBe(65)
    expect(lines[1]![0]!.x).toBe(80)
  })

  it('leaves off what does not fit in the allowed lines', () => {
    expect(layoutWords(words(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']), 0, 80, 1, measure, 100).flat()).toHaveLength(1)
  })
})

describe('boldChunk', () => {
  it('shows the few words around the one being said', () => {
    const w = words(['one', 'two', 'three', 'four', 'five', 'six'])
    expect(boldChunk(w, 1, 1000, measure).words.map((x) => x.text)).toHaveLength(BOLD_MAX_WORDS)
    const later = boldChunk(w, 5, 1000, measure)
    expect(later.first).toBe(4)
    expect(later.words.map((x) => x.text)).toEqual(['five', 'six'])
    expect(boldChunk(w, -1, 1000, measure).first).toBe(0)
  })
})

describe('drawCaptions', () => {
  function recorder() {
    const fills: Array<{ text: string; style: unknown }> = []
    const ctx = new Proxy({}, {
      get(target: Record<string, unknown>, name: string) {
        if (name in target) return target[name]
        if (name === 'measureText') return (s: string) => ({ width: s.length * 10 })
        if (name === 'fillText') return (text: string) => fills.push({ text, style: target.fillStyle })
        return () => {}
      },
      set(target: Record<string, unknown>, name: string, value) { target[name] = value; return true }
    }) as unknown as Ctx2D
    return { ctx, fills }
  }
  const caps = (style: CaptionSettings['style']): CaptionSettings => ({ enabled: true, size: 1, position: 'bottom', style, highlight: '#00ff88', cues: [{ id: 'a', start: 0, end: 3, text: 'one two three' }] })

  it('marks the word being said in karaoke and bold, and draws the plain styles whole', () => {
    const karaoke = recorder()
    drawCaptions(karaoke.ctx, { width: 1920, height: 1080 }, caps('karaoke'), 1.5)
    expect(karaoke.fills.map((f) => f.text)).toEqual(['one', 'two', 'three'])
    expect(karaoke.fills[1]!.style).toBe('#111318') // dark text on the highlight pill
    const bold = recorder()
    drawCaptions(bold.ctx, { width: 1920, height: 1080 }, caps('bold'), 1.5)
    expect(bold.fills.find((f) => f.style === '#00ff88')!.text).toBe('TWO')
    const box = recorder()
    drawCaptions(box.ctx, { width: 1920, height: 1080 }, caps(undefined), 1.5)
    expect(box.fills.map((f) => f.text)).toEqual(['one two three'])
  })
})
