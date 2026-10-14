// Encoder settings derived from the output size. Pure, tested.

import type { ExportQuality, GifOptions } from '../../shared/types'

const BY_HEIGHT: Record<number, number> = {
  720: 5_000_000,
  1080: 8_000_000,
  1440: 14_000_000,
  2160: 28_000_000
}

/**
 * H264 target bitrate for an output of the given height. Known heights use the
 * table; anything else scales the 1080p figure by pixel count so odd sizes
 * (source aspect) still get a sane number, clamped to [2, 60] Mbps.
 */
export function pickBitrate(height: number, quality: ExportQuality = 'balanced', fps = 30, width?: number): number {
  const exact = BY_HEIGHT[height]
  const h = Number.isFinite(height) && height > 0 ? height : 1080
  const base = exact ?? Math.round(Math.min(60_000_000, Math.max(2_000_000, 12_000_000 * (h / 1080) ** 2)))
  const frameFactor = Number.isFinite(fps) && fps > 0 ? Math.max(1, fps / 30) : 1
  const aspectFactor = width && Number.isFinite(width) && width > 0 ? width / (h * 16 / 9) : 1
  return Math.round(Math.min(120_000_000, Math.max(2_000_000, base * QUALITY_FACTOR[quality] * frameFactor * aspectFactor)))
}

export const QUALITY_FACTOR: Record<ExportQuality, number> = { small: 0.5, balanced: 1, high: 1.6 }

/** GIF frame rate per quality; GIFs are dominated by frame count. */
/** Frame rate of a GIF: the one asked for, or the quality preset's. */
export function gifFps(quality: ExportQuality = 'balanced', chosen?: number): number {
  if (chosen && Number.isFinite(chosen)) return Math.min(50, Math.max(1, Math.round(chosen)))
  return quality === 'small' ? 12 : quality === 'high' ? 20 : GIF_FPS
}

/** GIF caps: ffmpeg converts the temp MP4 at 15 fps, at most 960 px wide. */
export const GIF_FPS = 15
export const GIF_MAX_WIDTH = 960

/** Width of a GIF: the one asked for, or the quality preset's cap; never wider than the video. */
export function gifWidth(outputWidth: number, quality: ExportQuality = 'balanced', chosen?: number): number {
  const cap = chosen && Number.isFinite(chosen) ? chosen : quality === 'small' ? 720 : quality === 'high' ? 1280 : GIF_MAX_WIDTH
  return Math.max(1, Math.min(Math.round(outputWidth), Math.round(cap)))
}

/** Rough file-size estimate for the export sheet, in bytes. */
export function estimateBytes(args: { kind: 'mp4' | 'gif'; height: number; width: number; seconds: number; quality?: ExportQuality; fps?: number; gif?: GifOptions }): number {
  if (!(args.seconds > 0)) return 0
  const q = args.quality ?? 'balanced'
  if (args.kind === 'mp4') return (pickBitrate(args.height, q, args.fps, args.width) / 8) * args.seconds + (160_000 / 8) * args.seconds
  // GIF: ~0.5 byte per pixel per frame after palette + LZW is a fair average for UI captures.
  const w = gifWidth(args.width, q, args.gif?.width)
  const h = args.width > 0 ? Math.round((args.height * w) / args.width) : args.height
  return w * h * 0.5 * gifFps(q, args.gif?.fps) * args.seconds
}

export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
