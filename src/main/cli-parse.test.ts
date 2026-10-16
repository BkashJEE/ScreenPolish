import { describe, expect, it } from 'vitest'
import { CliUsageError, DEFAULT_START, looksLikeCli, parseCli, replyTimeoutMs } from './cli-parse'

describe('looksLikeCli', () => {
  it('ignores electron noise and detects command words', () => {
    expect(looksLikeCli(['.', 'status'])).toBe(true)
    expect(looksLikeCli(['--inspect=9229', 'clip', '--seconds', '5'])).toBe(true)
    expect(looksLikeCli([])).toBe(false)
    expect(looksLikeCli(['.'])).toBe(false)
    expect(looksLikeCli(['C:\\some\\file.mp4'])).toBe(false)
  })
})

describe('parseCli', () => {
  it('parses simple commands', () => {
    expect(parseCli(['status'])).toEqual({ kind: 'status' })
    expect(parseCli(['list'])).toEqual({ kind: 'list' })
    expect(parseCli([])).toEqual({ kind: 'help' })
    expect(parseCli(['open'])).toEqual({ kind: 'open', folder: null })
    expect(parseCli(['open', 'C:\\r\\x'])).toEqual({ kind: 'open', folder: 'C:\\r\\x' })
  })

  it('parses record start with options', () => {
    expect(parseCli(['record', 'start'])).toEqual({ kind: 'record-start', start: DEFAULT_START })
    expect(parseCli(['record', 'start', '--display', '2', '--mic', '--no-system', '--fps', '60', '--region', '10,20,300,200'])).toEqual({
      kind: 'record-start',
      start: { display: 2, region: { x: 10, y: 20, width: 300, height: 200 }, mic: true, system: false, webcam: false, fps: 60 }
    })
  })

  it('parses record stop with export', () => {
    expect(parseCli(['record', 'stop', '--export', 'gif', '--name', 'demo'])).toEqual({ kind: 'record-stop', export: { kind: 'gif', name: 'demo' } })
    expect(parseCli(['record', 'stop'])).toEqual({ kind: 'record-stop', export: { kind: null, name: null } })
  })

  it('parses clip', () => {
    expect(parseCli(['clip', '--seconds', '8', '--export', 'mp4'])).toEqual({
      kind: 'clip',
      seconds: 8,
      start: DEFAULT_START,
      export: { kind: 'mp4', name: null }
    })
    expect(() => parseCli(['clip'])).toThrow(CliUsageError)
  })

  it('parses export with a default kind', () => {
    expect(parseCli(['export', '2026-09-01_21-05-05'])).toEqual({ kind: 'export', folder: '2026-09-01_21-05-05', export: { kind: 'mp4', name: null } })
    expect(parseCli(['export', 'x', '--kind', 'gif'])).toEqual({ kind: 'export', folder: 'x', export: { kind: 'gif', name: null } })
    expect(() => parseCli(['export'])).toThrow(CliUsageError)
  })

  it('rejects bad input clearly', () => {
    expect(() => parseCli(['record', 'dance'])).toThrow(/start or stop/)
    expect(() => parseCli(['record', 'start', '--fps', '24'])).toThrow(/30 or 60/)
    expect(() => parseCli(['record', 'start', '--region', '1,2,3'])).toThrow(/X,Y,W,H/)
    expect(() => parseCli(['record', 'start', '--export', 'mp4'])).toThrow(/not valid here/)
    expect(() => parseCli(['bogus'])).toThrow(/Unknown command/)
    expect(() => parseCli(['clip', '--seconds', '5', '--wat'])).toThrow(/Unknown option/)
  })
})

describe('replyTimeoutMs', () => {
  it('scales with the clip length and export', () => {
    expect(replyTimeoutMs(parseCli(['status']))).toBe(30_000)
    expect(replyTimeoutMs(parseCli(['record', 'start']))).toBe(150_000)
    expect(replyTimeoutMs(parseCli(['clip', '--seconds', '10']))).toBe(160_000)
    expect(replyTimeoutMs(parseCli(['clip', '--seconds', '10', '--export', 'gif']))).toBe(160_000 + 600_000)
  })
})

describe('replay commands', () => {
  it('parses start with a buffer length', () => {
    expect(parseCli(['replay', 'start', '--seconds', '30'])).toEqual({
      kind: 'replay-start', seconds: 30, start: { ...DEFAULT_START }
    })
  })

  it('carries the display and frame rate through to the buffer', () => {
    const parsed = parseCli(['replay', 'start', '--seconds', '60', '--display', '2', '--fps', '60'])
    expect(parsed).toMatchObject({ kind: 'replay-start', seconds: 60 })
    expect((parsed as { start: { display: unknown; fps: number } }).start).toMatchObject({ display: 2, fps: 60 })
  })

  it('insists on a length, since there is no sensible default for memory', () => {
    expect(() => parseCli(['replay', 'start'])).toThrow(/--seconds/)
  })

  it('parses save and stop, which take nothing', () => {
    expect(parseCli(['replay', 'save'])).toEqual({ kind: 'replay-save' })
    expect(parseCli(['replay', 'stop'])).toEqual({ kind: 'replay-stop' })
    expect(() => parseCli(['replay', 'save', '--seconds', '5'])).toThrow(/Unexpected/)
  })

  it('rejects a subcommand it does not have', () => {
    expect(() => parseCli(['replay'])).toThrow(/start, save or stop/)
    expect(() => parseCli(['replay', 'discard'])).toThrow(/start, save or stop/)
  })

  it('is recognised as a command, so the CLI does not treat it as app argv', () => {
    expect(looksLikeCli(['replay', 'save'])).toBe(true)
  })
})

describe('sequence create', () => {
  it('takes the takes in order, and a name to export it by', () => {
    expect(looksLikeCli(['sequence', 'create', 'a', 'b'])).toBe(true)
    expect(parseCli(['sequence', 'create', '--out', 'Reel', '2026-10-15_12-37-15', '2026-10-15_12-41-02'])).toEqual({
      kind: 'sequence-create',
      takes: ['2026-10-15_12-37-15', '2026-10-15_12-41-02'],
      title: 'Reel'
    })
    expect(parseCli(['sequence', 'create', 'a', '--name', 'X', 'b'])).toEqual({ kind: 'sequence-create', takes: ['a', 'b'], title: 'X' })
    expect(parseCli(['sequence', 'create', 'a'])).toEqual({ kind: 'sequence-create', takes: ['a'], title: null })
  })

  it('says what is missing', () => {
    expect(() => parseCli(['sequence'])).toThrow(/expects create/)
    expect(() => parseCli(['sequence', 'create'])).toThrow(/one or more takes/)
    expect(() => parseCli(['sequence', 'create', '--out'])).toThrow(/needs a value/)
    expect(() => parseCli(['sequence', 'create', '--fps', '30', 'a'])).toThrow(/Unknown option/)
  })

  it('gives a sequence export time to render every take', () => {
    expect(replyTimeoutMs({ kind: 'export', folder: 'x', export: { kind: 'mp4', name: null } })).toBe(60 * 60 * 1000)
  })
})
