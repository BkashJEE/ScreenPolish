import { describe, expect, it } from 'vitest'
import { addVoiceoverClip, normalizeVoiceover, replaceCuesIn, voiceAt, voiceoverCues, voiceoverMixArgs, type VoiceoverClip } from './voiceover'

const clip = (id: string, atSec: number, durationSec: number): VoiceoverClip => ({ id, file: `voiceover-${id}.m4a`, atSec, durationSec, volume: 1 })

describe('voiceover clips', () => {
  it('keep only clips that point at a voiceover file in the take', () => {
    const clips = normalizeVoiceover([clip('bbbb', 5, 2), { ...clip('aaaa', 1, 2), volume: 9 }, { ...clip('cccc', 1, 1), file: '../screen.mp4' }, { ...clip('dddd', 1, 0) }, clip('bbbb', 9, 1), 'junk'])
    expect(clips.map((c) => c.id)).toEqual(['aaaa', 'bbbb'])
    expect(clips[0]!.volume).toBe(2)
    expect(normalizeVoiceover(undefined)).toEqual([])
  })

  it('replace what a new recording covers', () => {
    const r = addVoiceoverClip([clip('aaaa', 0, 3), clip('bbbb', 4, 3), clip('cccc', 10, 2)], clip('dddd', 2, 3))
    expect(r.clips.map((c) => c.id)).toEqual(['dddd', 'cccc'])
    expect(r.replaced.map((c) => c.id)).toEqual(['aaaa', 'bbbb'])
  })

  it('know which one plays when', () => {
    const clips = [clip('aaaa', 2, 3)]
    expect(voiceAt(clips, 3)).toMatchObject({ clip: { id: 'aaaa' }, localSec: 1 })
    expect(voiceAt(clips, 5)).toBeNull()
  })
})

describe('captions from a voiceover', () => {
  it('move onto the recording clock and drop what lands on a card', () => {
    // Output = source + 3 (a 3 s intro card), and nothing before 3 s is the recording.
    const toSource = (t: number) => (t < 3 ? null : t - 3)
    const cues = voiceoverCues(
      [
        { id: 'x', start: 0, end: 1, text: 'during the card' },
        { id: 'y', start: 2, end: 4, text: 'over the take', words: [{ text: 'over', start: 2, end: 2.5 }, { text: 'the', start: 2.5, end: 3 }, { text: 'take', start: 3, end: 4 }] }
      ],
      clip('aaaa', 2, 5),
      toSource
    )
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ start: 1, end: 3, text: 'over the take' })
    expect(cues[0]!.words!.map((w) => w.start)).toEqual([1, 1.5, 2])
  })

  it('replace only the cues inside the clip', () => {
    const existing = [{ id: 'a', start: 0, end: 1, text: 'keep' }, { id: 'b', start: 2, end: 3, text: 'drop' }, { id: 'c', start: 9, end: 10, text: 'keep too' }]
    expect(replaceCuesIn(existing, 1.5, 5, [{ id: 'n', start: 2, end: 4, text: 'new' }]).map((c) => c.text)).toEqual(['keep', 'new', 'keep too'])
  })
})

describe('the voiceover mix', () => {
  it('delays each voice, ducks the take under it, and copies the video', () => {
    const args = voiceoverMixArgs('in.mp4', [{ path: 'a.m4a', atSec: 1.5, volume: 1 }, { path: 'b.m4a', atSec: 10, volume: 0.5 }], { hasAudio: true, durationSec: 20, duck: true }, 'out.mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('adelay=1500:all=1')
    expect(graph).toContain('adelay=10000:all=1')
    expect(graph).toContain('sidechaincompress')
    expect(args).toContain('copy')
    expect(voiceoverMixArgs('in.mp4', [{ path: 'a.m4a', atSec: 0, volume: 1 }], { hasAudio: false, durationSec: 8, duck: true }, 'o.mp4').join(' ')).toContain('apad=whole_dur=8.000,atrim=duration=8.000')
  })
})
