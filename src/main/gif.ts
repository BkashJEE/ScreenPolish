// Pure ffmpeg argument construction for the GIF export (two-pass palette in one filter graph).

export const DEFAULT_GIF_FPS = 15
export const DEFAULT_GIF_WIDTH = 960

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function gifFilter(fps = DEFAULT_GIF_FPS, width = DEFAULT_GIF_WIDTH): string {
  const f = clampInt(fps, DEFAULT_GIF_FPS, 1, 50)
  const w = clampInt(width, DEFAULT_GIF_WIDTH, 16, 4096)
  return (
    `fps=${f},scale=${w}:-1:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=stats_mode=diff[p];` +
    `[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
  )
}

/** `loop: false` plays once and holds the last frame (ffmpeg's -loop -1); anything else loops forever. */
export function ffmpegGifArgs(inputMp4: string, outputGif: string, fps?: number, width?: number, loop?: boolean): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputMp4, '-vf', gifFilter(fps, width), '-loop', loop === false ? '-1' : '0', outputGif]
}
