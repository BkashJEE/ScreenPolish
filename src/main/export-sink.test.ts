import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PART_SUFFIX, assertInsideRoot, createExportSink } from './export-sink'

describe('assertInsideRoot', () => {
  const root = path.resolve('C:/Users/x/Videos/Polish')

  it('accepts subfolders and normalizes', () => {
    expect(assertInsideRoot(root, path.join(root, '2026-09-01_00-00-00'))).toBe(path.join(root, '2026-09-01_00-00-00'))
    expect(assertInsideRoot(root, path.join(root, 'a', '..', 'b'))).toBe(path.join(root, 'b'))
  })

  it('rejects the root itself, siblings and traversal', () => {
    expect(() => assertInsideRoot(root, root)).toThrow()
    expect(() => assertInsideRoot(root, path.join(root, '..', 'Polish2', 'x'))).toThrow()
    expect(() => assertInsideRoot(root, path.join(root, 'x', '..', '..', 'y'))).toThrow()
    expect(() => assertInsideRoot(root, 'C:/Windows')).toThrow()
  })
})

describe('an export never writes to the name the user will see', () => {
  const makeRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-export-'))
    fs.mkdirSync(path.join(root, 'take'), { recursive: true })
    return root
  }
  const sink = (root: string) => createExportSink({ root: () => root, ffmpegPath: () => 'ffmpeg-not-used' })

  it('writes to a part file, leaving no mp4 behind until it finishes', async () => {
    const root = makeRoot()
    const s = sink(root)
    const { path: writePath } = await s.begin({ folder: path.join(root, 'take'), kind: 'mp4', name: 'Demo' })
    expect(writePath.endsWith(PART_SUFFIX)).toBe(true)
    // The folder must not yet contain anything that looks like a finished export.
    const listed = fs.readdirSync(path.join(root, 'take', 'exports'))
    expect(listed.filter((f) => f.endsWith('.mp4') && !f.endsWith(PART_SUFFIX))).toEqual([])
  })

  it('writes into another folder when asked, only inside the recordings root', async () => {
    const root = makeRoot()
    const s = sink(root)
    const into = path.join(root, 'sequence', 'parts')
    const { path: writePath } = await s.begin({ folder: path.join(root, 'take'), kind: 'mp4', name: 'clip-0', into })
    expect(path.dirname(writePath)).toBe(into)
    expect(fs.existsSync(path.join(root, 'take', 'exports'))).toBe(false)
    await expect(s.begin({ folder: path.join(root, 'take'), kind: 'mp4', name: 'x', into: path.join(root, '..') })).rejects.toThrow(/outside/)
  })

  it('refuses to save a render that produced nothing, and says so', async () => {
    const root = makeRoot()
    const s = sink(root)
    const { exportId } = await s.begin({ folder: path.join(root, 'take'), kind: 'mp4', name: 'Empty' })
    // No chunks: exactly the case that used to leave a 0 byte Empty.mp4.
    await expect(s.end({ exportId })).rejects.toThrow(/produced no video/i)
    expect(fs.readdirSync(path.join(root, 'take', 'exports'))).toEqual([])
  })

  it('clears part files abandoned by an export that was killed', async () => {
    const root = makeRoot()
    const exportsDir = path.join(root, 'take', 'exports')
    fs.mkdirSync(exportsDir, { recursive: true })
    const stale = path.join(exportsDir, `Old.mp4.exp-1${PART_SUFFIX}`)
    const fresh = path.join(exportsDir, `New.mp4.exp-2${PART_SUFFIX}`)
    fs.writeFileSync(stale, 'x')
    fs.writeFileSync(fresh, 'x')
    const old = Date.now() - 7 * 60 * 60 * 1000
    fs.utimesSync(stale, old / 1000, old / 1000)

    await sink(root).begin({ folder: path.join(root, 'take'), kind: 'mp4', name: 'Next' })
    expect(fs.existsSync(stale)).toBe(false)
    // A part file from an export running right now must survive.
    expect(fs.existsSync(fresh)).toBe(true)
  })
})
