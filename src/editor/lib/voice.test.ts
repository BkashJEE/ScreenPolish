import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '../../shared/types'
import { withCleanVoice } from './voice'

const urls = { screen: 's', mic: 'mic', micClean: 'clean', system: 'sys' }

describe('withCleanVoice', () => {
  it('uses the cleaned microphone only while switched on and made', () => {
    const on = { ...DEFAULT_PROJECT, audio: { ...DEFAULT_PROJECT.audio, micClean: true } }
    expect(withCleanVoice(on, urls).mic).toBe('clean')
    expect(withCleanVoice(DEFAULT_PROJECT, urls).mic).toBe('mic')
    expect(withCleanVoice(on, { screen: 's', mic: 'mic' }).mic).toBe('mic')
    expect(withCleanVoice(on, { screen: 's', mic: 'mic' }, 'fresh').mic).toBe('fresh')
    expect(withCleanVoice(on, urls).system).toBe('sys')
  })
})
