// Burns the current caption into the frame. Screen space, on top of
// everything, outside the camera: captions do not zoom with the content.

import { DEFAULT_CAPTION_HIGHLIGHT, captionAt, cueWords, wordIndexAt, wrapCaption, type CaptionSettings, type CaptionWord } from '../shared/captions'
import type { Ctx2D } from './render-frame'

/** Base text height as a fraction of the shorter output side, at size 1. */
export const CAPTION_BASE = 0.042
export const CAPTION_FONT = '"Instrument Sans"'
/** Bold captions are this much larger, and show a few words at a time. */
export const BOLD_SCALE = 1.45
export const BOLD_MAX_WORDS = 4

interface PlacedWord {
  word: CaptionWord
  /** Index into the cue's words. */
  index: number
  x: number
  width: number
}

/**
 * Words laid out in centred lines no wider than `maxWidth`, at most
 * `maxLines` of them, `gap` spaces apart. Words that do not fit are left off the end; the box
 * style keeps its own ellipsis wrap, so this is only for the word styles.
 */
export function layoutWords(words: readonly CaptionWord[], firstIndex: number, maxWidth: number, maxLines: number, measure: (s: string) => number, centreX: number, gap = 1): PlacedWord[][] {
  const space = measure(' ') * gap
  const lines: Array<Array<{ word: CaptionWord; index: number; width: number }>> = []
  let line: Array<{ word: CaptionWord; index: number; width: number }> = []
  let width = 0
  words.forEach((word, i) => {
    const w = measure(word.text)
    if (line.length && width + space + w > maxWidth) {
      lines.push(line)
      line = []
      width = 0
    }
    width += (line.length ? space : 0) + w
    line.push({ word, index: firstIndex + i, width: w })
  })
  if (line.length) lines.push(line)
  return lines.slice(0, maxLines).map((l) => {
    const total = l.reduce((a, p) => a + p.width, 0) + space * (l.length - 1)
    let x = centreX - total / 2
    return l.map((p) => {
      const placed = { ...p, x }
      x += p.width + space
      return placed
    })
  })
}

/**
 * The few words Bold shows around the word being said: the cue cut into
 * chunks of up to BOLD_MAX_WORDS that each fit one line.
 */
export function boldChunk(words: readonly CaptionWord[], current: number, maxWidth: number, measure: (s: string) => number, gap = 1): { first: number; words: CaptionWord[] } {
  const space = measure(' ') * gap
  const chunks: Array<{ first: number; words: CaptionWord[] }> = []
  let chunk: CaptionWord[] = []
  let first = 0
  let width = 0
  words.forEach((word, i) => {
    const w = measure(word.text)
    if (chunk.length && (chunk.length >= BOLD_MAX_WORDS || width + space + w > maxWidth)) {
      chunks.push({ first, words: chunk })
      chunk = []
      width = 0
      first = i
    }
    width += (chunk.length ? space : 0) + w
    chunk.push(word)
  })
  if (chunk.length) chunks.push({ first, words: chunk })
  const at = Math.max(0, current)
  return chunks.find((c) => at >= c.first && at < c.first + c.words.length) ?? chunks[0] ?? { first: 0, words: [] }
}

function roundedBox(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function drawCaptions(ctx: Ctx2D, output: { width: number; height: number }, captions: CaptionSettings | undefined, tSec: number): void {
  if (!captions?.enabled || captions.cues.length === 0) return
  const cue = captionAt(tSec, captions.cues)
  if (!cue) return
  const style = captions.style ?? 'box'
  const highlight = captions.highlight ?? DEFAULT_CAPTION_HIGHLIGHT
  const minSide = Math.min(output.width, output.height)
  const fontPx = minSide * CAPTION_BASE * captions.size * (style === 'bold' ? BOLD_SCALE : 1)
  const lineHeight = fontPx * 1.25
  const padX = fontPx * 0.6
  const padY = fontPx * 0.32
  const maxText = output.width * 0.84 - padX * 2
  const margin = output.height * 0.07
  const centreX = output.width / 2

  ctx.save()
  ctx.textBaseline = 'middle'

  if (style === 'box') {
    ctx.font = `600 ${fontPx}px ${CAPTION_FONT}`
    ctx.textAlign = 'center'
    const lines = wrapCaption(cue.text, maxText, (s) => ctx.measureText(s).width)
    if (lines.length) {
      const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width))
      const boxW = textWidth + padX * 2
      const boxH = lines.length * lineHeight + padY * 2
      const x = (output.width - boxW) / 2
      const y = captions.position === 'top' ? margin : output.height - margin - boxH
      ctx.fillStyle = 'rgba(8, 12, 16, 0.78)'
      roundedBox(ctx, x, y, boxW, boxH, Math.min(fontPx * 0.35, boxH / 2))
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      lines.forEach((line, i) => ctx.fillText(line, centreX, y + padY + lineHeight * (i + 0.5)))
    }
    ctx.restore()
    return
  }

  // Word styles: each word placed on its own, so the one being said can be marked.
  const all = cueWords(cue)
  const current = wordIndexAt(all, tSec)
  ctx.font = style === 'bold' ? `800 ${fontPx}px ${CAPTION_FONT}` : `600 ${fontPx}px ${CAPTION_FONT}`
  ctx.textAlign = 'left'
  const shown = (w: CaptionWord): CaptionWord => (style === 'bold' ? { ...w, text: w.text.toUpperCase() } : w)
  const measure = (s: string) => ctx.measureText(s).width
  // The marked word grows (Bold) or sits on a pill (Karaoke), so those styles leave it more room.
  const gap = style === 'minimal' ? 1 : 1.6
  const chunk = style === 'bold' ? boldChunk(all.map(shown), current, maxText, measure, gap) : { first: 0, words: all.map(shown) }
  const lines = layoutWords(chunk.words, chunk.first, maxText, style === 'bold' ? 1 : 2, measure, centreX, gap)
  if (lines.length === 0) {
    ctx.restore()
    return
  }
  const blockH = lines.length * lineHeight
  const top = captions.position === 'top' ? margin + padY : output.height - margin - padY - blockH

  if (style === 'karaoke') {
    const left = Math.min(...lines.map((l) => l[0]!.x)) - padX
    const right = Math.max(...lines.map((l) => l.at(-1)!.x + l.at(-1)!.width)) + padX
    ctx.fillStyle = 'rgba(8, 12, 16, 0.78)'
    roundedBox(ctx, left, top - padY, right - left, blockH + padY * 2, Math.min(fontPx * 0.35, (blockH + padY * 2) / 2))
    ctx.fill()
  }

  lines.forEach((line, li) => {
    const y = top + lineHeight * (li + 0.5)
    for (const p of line) {
      const isCurrent = p.index === current
      const said = p.index < current
      if (style === 'karaoke') {
        if (isCurrent) {
          ctx.fillStyle = highlight
          roundedBox(ctx, p.x - fontPx * 0.18, y - fontPx * 0.62, p.width + fontPx * 0.36, fontPx * 1.24, fontPx * 0.28)
          ctx.fill()
          ctx.fillStyle = '#111318'
        } else ctx.fillStyle = said ? '#ffffff' : 'rgba(255, 255, 255, 0.55)'
        ctx.fillText(p.word.text, p.x, y)
      } else if (style === 'bold') {
        ctx.save()
        if (isCurrent) {
          // A small pop on the word being said, about its own centre.
          const cx = p.x + p.width / 2
          ctx.translate(cx, y)
          ctx.scale(1.08, 1.08)
          ctx.translate(-cx, -y)
        }
        ctx.lineJoin = 'round'
        ctx.lineWidth = fontPx * 0.16
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)'
        ctx.strokeText(p.word.text, p.x, y)
        ctx.fillStyle = isCurrent ? highlight : '#ffffff'
        ctx.fillText(p.word.text, p.x, y)
        ctx.restore()
      } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
        ctx.shadowBlur = fontPx * 0.3
        ctx.shadowOffsetY = fontPx * 0.06
        ctx.fillStyle = '#ffffff'
        ctx.fillText(p.word.text, p.x, y)
      }
    }
  })
  ctx.restore()
}
