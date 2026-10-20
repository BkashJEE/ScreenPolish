import { contentRect, type Rect } from '../shared/layout'
import type { MockupSettings } from '../shared/types'

export interface MockupGeometry {
  outer: Rect
  content: Rect
  headerPx: number
  borderPx: number
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function inset(rect: Rect, x: number, top: number, bottom = top): Rect {
  return {
    x: rect.x + x,
    y: rect.y + top,
    width: Math.max(0, rect.width - x * 2),
    height: Math.max(0, rect.height - top - bottom)
  }
}

function fit(box: Rect, aspect: number): Rect {
  if (!(box.width > 0) || !(box.height > 0) || !(aspect > 0)) return box
  let width = box.width
  let height = width / aspect
  if (height > box.height) {
    height = box.height
    width = height * aspect
  }
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height
  }
}

/** Shared geometry for preview, hit testing, thumbnails and export. */
/** The laptop's base is this much wider than its screen lid. */
export const LAPTOP_BASE_WIDEN = 1.14
/** Base height as a share of the lid's width. */
export const LAPTOP_BASE_HEIGHT = 0.034
/** Top bezel (with the camera notch) and chin, in side-bezel widths. */
const LAPTOP_TOP = 1.5
const LAPTOP_CHIN = 1.9

/** Side bezel as a share of the lid's width, from the Bezel slider. */
export function laptopBezel(headerSize: number): number {
  return clamp(headerSize * 0.3, 0.0075, 0.042)
}

export function mockupGeometry(
  output: { width: number; height: number },
  videoSize: { width: number; height: number },
  padding: number,
  settings: MockupSettings
): MockupGeometry {
  const plain = contentRect(output, videoSize, padding)
  if (settings.kind === 'none') return { outer: plain, content: plain, headerPx: 0, borderPx: 0 }

  const minSide = Math.min(output.width, output.height)
  const safePadding = clamp(padding, 0, 0.3) * minSide
  const available: Rect = {
    x: safePadding,
    y: safePadding,
    width: Math.max(0, output.width - safePadding * 2),
    height: Math.max(0, output.height - safePadding * 2)
  }
  const videoAspect = videoSize.width / Math.max(videoSize.height, 1)

  if (settings.kind === 'laptop') {
    // The whole laptop (lid over a wider base) fits the frame; `outer` is the
    // lid alone, so the shadow and the frame's own shape follow the screen,
    // and the base is drawn below it.
    const bf = laptopBezel(settings.headerSize)
    const lidPerWidth = (1 - 2 * bf) / videoAspect + (LAPTOP_TOP + LAPTOP_CHIN) * bf
    const device = fit(available, LAPTOP_BASE_WIDEN / (lidPerWidth + LAPTOP_BASE_HEIGHT))
    const lidW = device.width / LAPTOP_BASE_WIDEN
    const borderPx = lidW * bf
    const outer: Rect = { x: device.x + (device.width - lidW) / 2, y: device.y, width: lidW, height: lidW * lidPerWidth }
    const content: Rect = { x: outer.x + borderPx, y: outer.y + borderPx * LAPTOP_TOP, width: lidW - borderPx * 2, height: (lidW - borderPx * 2) / videoAspect }
    return { outer, content, headerPx: borderPx * LAPTOP_TOP, borderPx }
  }

  if (settings.kind === 'phone') {
    const outer = fit(available, 9 / 19.5)
    const borderPx = clamp(settings.headerSize, 0.025, 0.14) * Math.min(outer.width, outer.height)
    const screenBox = inset(outer, borderPx, borderPx * 1.45, borderPx * 1.25)
    return { outer, content: fit(screenBox, videoAspect), headerPx: borderPx * 1.45, borderPx }
  }

  const headerFraction = clamp(settings.headerSize, 0.045, 0.18)
  const outer = fit(available, videoAspect * (1 - headerFraction))
  const borderPx = Math.max(1, Math.min(outer.width, outer.height) * 0.004)
  const headerPx = outer.height * headerFraction
  const contentBox = inset(outer, borderPx, headerPx, borderPx)
  return { outer, content: fit(contentBox, videoAspect), headerPx, borderPx }
}

function roundedRect(ctx: Ctx2D, rect: Rect, radius: number): void {
  const r = clamp(radius, 0, Math.min(rect.width, rect.height) / 2)
  ctx.beginPath()
  if (r === 0) {
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    return
  }
  ctx.moveTo(rect.x + r, rect.y)
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height, r)
  ctx.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x, rect.y + rect.height, r)
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y, r)
  ctx.arcTo(rect.x, rect.y, rect.x + rect.width, rect.y, r)
  ctx.closePath()
}

function dot(ctx: Ctx2D, x: number, y: number, radius: number, fill: string): void {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

/**
 * A laptop: a black-bezelled lid with a camera notch, an aluminium rim, and a
 * wider base below it with a thumb notch. Dark is space black, light silver.
 * Drawn from shapes, like the other shells; no device artwork is used.
 */
function drawLaptop(ctx: Ctx2D, geometry: MockupGeometry, settings: MockupSettings): void {
  const { outer, content, headerPx, borderPx } = geometry
  const dark = settings.theme === 'dark'
  const metal = dark ? '#2e3034' : '#d3d6da'
  const metalLight = dark ? '#4a4d53' : '#eef0f2'
  const metalShade = dark ? '#1b1c1f' : '#9fa4aa'
  const lidRadius = Math.min(Math.max(0, settings.radius), outer.width * 0.022)

  ctx.save()
  // Lid: aluminium rim, black glass bezel inside it.
  roundedRect(ctx, outer, lidRadius)
  ctx.fillStyle = metal
  ctx.fill()
  const rim = Math.max(1, outer.width * 0.0035)
  roundedRect(ctx, inset(outer, rim, rim), Math.max(0, lidRadius - rim))
  ctx.fillStyle = '#0b0b0d'
  ctx.fill()

  // Camera notch, hanging from the top edge into the screen.
  const notchW = outer.width * 0.085
  const notchH = headerPx * 0.95
  const notch: Rect = { x: outer.x + (outer.width - notchW) / 2, y: outer.y + rim, width: notchW, height: notchH }
  ctx.beginPath()
  const nr = Math.min(notchH * 0.45, notchW / 4)
  ctx.moveTo(notch.x, notch.y)
  ctx.lineTo(notch.x + notch.width, notch.y)
  ctx.lineTo(notch.x + notch.width, notch.y + notch.height - nr)
  ctx.arcTo(notch.x + notch.width, notch.y + notch.height, notch.x + notch.width - nr, notch.y + notch.height, nr)
  ctx.lineTo(notch.x + nr, notch.y + notch.height)
  ctx.arcTo(notch.x, notch.y + notch.height, notch.x, notch.y + notch.height - nr, nr)
  ctx.closePath()
  ctx.fillStyle = '#000000'
  ctx.fill()
  dot(ctx, outer.x + outer.width / 2, notch.y + notch.height * 0.45, Math.max(1, notchH * 0.16), '#1c2230')

  // Hinge, then the base: a slab wider than the lid, lit from above, with a
  // shallow notch at the front to open it by.
  const baseW = outer.width * LAPTOP_BASE_WIDEN
  const baseH = outer.width * LAPTOP_BASE_HEIGHT
  const base: Rect = { x: outer.x + (outer.width - baseW) / 2, y: outer.y + outer.height, width: baseW, height: baseH }
  const hingeW = outer.width * 0.98
  ctx.fillStyle = metalShade
  ctx.fillRect(outer.x + (outer.width - hingeW) / 2, base.y - Math.max(1, baseH * 0.12), hingeW, Math.max(1, baseH * 0.12))
  ctx.beginPath()
  const br = baseH * 0.55
  ctx.moveTo(base.x, base.y)
  ctx.lineTo(base.x + base.width, base.y)
  ctx.lineTo(base.x + base.width, base.y + base.height - br)
  ctx.arcTo(base.x + base.width, base.y + base.height, base.x + base.width - br, base.y + base.height, br)
  ctx.lineTo(base.x + br, base.y + base.height)
  ctx.arcTo(base.x, base.y + base.height, base.x, base.y + base.height - br, br)
  ctx.closePath()
  const shade = ctx.createLinearGradient(0, base.y, 0, base.y + base.height)
  shade.addColorStop(0, metalLight)
  shade.addColorStop(0.35, metal)
  shade.addColorStop(1, metalShade)
  ctx.fillStyle = shade
  ctx.fill()
  const grooveW = outer.width * 0.13
  const groove: Rect = { x: base.x + (base.width - grooveW) / 2, y: base.y, width: grooveW, height: baseH * 0.36 }
  ctx.beginPath()
  ctx.moveTo(groove.x, groove.y)
  ctx.lineTo(groove.x + groove.width, groove.y)
  ctx.arcTo(groove.x + groove.width, groove.y + groove.height, groove.x + groove.width - groove.height, groove.y + groove.height, groove.height)
  ctx.lineTo(groove.x + groove.height, groove.y + groove.height)
  ctx.arcTo(groove.x, groove.y + groove.height, groove.x, groove.y, groove.height)
  ctx.closePath()
  ctx.fillStyle = metalShade
  ctx.fill()

  // A hairline where the glass meets the picture.
  roundedRect(ctx, content, Math.max(0, settings.radius * 0.45))
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = Math.max(1, borderPx * 0.04)
  ctx.stroke()
  ctx.restore()
}

/** Draws original ScreenPolish chrome; no OpenVid code or assets are used. */
export function drawMockupChrome(ctx: Ctx2D, geometry: MockupGeometry, settings: MockupSettings): void {
  if (settings.kind === 'none') return
  if (settings.kind === 'laptop') return drawLaptop(ctx, geometry, settings)
  const { outer, content, headerPx, borderPx } = geometry
  const dark = settings.theme === 'dark'
  const shell = settings.color || (dark ? '#111a1a' : '#eef2ed')
  const line = dark ? 'rgba(217,255,105,0.20)' : 'rgba(10,24,20,0.20)'
  const header = dark ? 'rgba(4,11,10,0.88)' : 'rgba(255,255,255,0.82)'
  const control = dark ? 'rgba(225,238,232,0.52)' : 'rgba(12,24,21,0.46)'
  const radius = Math.max(0, settings.radius)

  ctx.save()
  roundedRect(ctx, outer, radius)
  ctx.fillStyle = shell
  ctx.fill()
  ctx.strokeStyle = line
  ctx.lineWidth = Math.max(1, borderPx)
  ctx.stroke()

  if (settings.kind === 'phone') {
    const islandW = Math.min(outer.width * 0.34, headerPx * 2.6)
    const islandH = Math.max(3, headerPx * 0.3)
    const island: Rect = {
      x: outer.x + (outer.width - islandW) / 2,
      y: outer.y + headerPx * 0.34,
      width: islandW,
      height: islandH
    }
    roundedRect(ctx, island, islandH / 2)
    ctx.fillStyle = dark ? '#020504' : '#18201e'
    ctx.fill()
    const homeW = outer.width * 0.26
    const home: Rect = {
      x: outer.x + (outer.width - homeW) / 2,
      y: outer.y + outer.height - Math.max(3, borderPx * 0.72),
      width: homeW,
      height: Math.max(2, borderPx * 0.18)
    }
    roundedRect(ctx, home, home.height / 2)
    ctx.fillStyle = control
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.rect(outer.x, outer.y, outer.width, headerPx)
    ctx.clip()
    roundedRect(ctx, outer, radius)
    ctx.fillStyle = header
    ctx.fill()
    ctx.restore()
    ctx.save()

    const cy = outer.y + headerPx / 2
    const r = clamp(headerPx * 0.105, 2, 7)
    const startX = outer.x + headerPx * 0.42
    dot(ctx, startX, cy, r, '#ff6258')
    dot(ctx, startX + r * 2.8, cy, r, '#ffbd2e')
    dot(ctx, startX + r * 5.6, cy, r, '#29c941')

    if (settings.kind === 'browser') {
      const address: Rect = {
        x: outer.x + Math.max(headerPx * 1.75, r * 9),
        y: outer.y + headerPx * 0.26,
        width: Math.max(10, outer.width - Math.max(headerPx * 2.2, r * 12)),
        height: headerPx * 0.48
      }
      roundedRect(ctx, address, address.height / 2)
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.075)' : 'rgba(8,20,17,0.08)'
      ctx.fill()
      ctx.fillStyle = control
      ctx.fillRect(address.x + address.height * 0.55, address.y + address.height * 0.43, Math.max(8, address.width * 0.26), Math.max(1, address.height * 0.12))
    } else {
      const titleW = Math.min(outer.width * 0.2, headerPx * 2.8)
      ctx.fillStyle = control
      ctx.fillRect(outer.x + (outer.width - titleW) / 2, cy, titleW, Math.max(1, headerPx * 0.045))
    }
  }

  roundedRect(ctx, content, Math.max(0, radius * 0.45))
  ctx.strokeStyle = line
  ctx.lineWidth = Math.max(1, borderPx)
  ctx.stroke()
  ctx.restore()
}
