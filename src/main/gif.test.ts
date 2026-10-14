import { describe, expect, it } from 'vitest'
import { DEFAULT_GIF_FPS, DEFAULT_GIF_WIDTH, ffmpegGifArgs, gifFilter } from './gif'

describe('gifFilter', () => {
  it('builds the two-pass palette graph', () => {
    expect(gifFilter(12, 640)).toBe(
      'fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle'
    )
  })
  it('falls back to defaults and clamps nonsense', () => {
    expect(gifFilter()).toContain(`fps=${DEFAULT_GIF_FPS},scale=${DEFAULT_GIF_WIDTH}:`)
    expect(gifFilter(Number.NaN, undefined)).toContain(`fps=${DEFAULT_GIF_FPS}`)
    expect(gifFilter(0, 4)).toContain('fps=1,scale=16:')
    expect(gifFilter(500, 99999)).toContain('fps=50,scale=4096:')
  })
})

describe('ffmpegGifArgs', () => {
  it('overwrites, loops forever and keeps paths verbatim', () => {
    const args = ffmpegGifArgs('C:\\in (2).mp4', 'C:\\out.gif', 15, 800)
    expect(args[0]).toBe('-y')
    expect(args).toContain('C:\\in (2).mp4')
    expect(args.at(-1)).toBe('C:\\out.gif')
    expect(args.slice(-3, -1)).toEqual(['-loop', '0'])
    expect(args[args.indexOf('-vf') + 1]).toBe(gifFilter(15, 800))
  })
})

describe('GIF looping', () => {
  it('loops forever unless asked to play once', () => {
    const loopValue = (args: string[]) => args[args.indexOf('-loop') + 1]
    expect(loopValue(ffmpegGifArgs('in.mp4', 'out.gif'))).toBe('0')
    expect(loopValue(ffmpegGifArgs('in.mp4', 'out.gif', 15, 960, true))).toBe('0')
    expect(loopValue(ffmpegGifArgs('in.mp4', 'out.gif', 15, 960, false))).toBe('-1')
  })
})
