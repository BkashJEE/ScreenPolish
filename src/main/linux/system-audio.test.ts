import { expect, it } from 'vitest'
import { leadingSilence, monitorArgs } from './system-audio'

it('explicitly captures the output monitor, never the default microphone', () => {
  const args = monitorArgs('alsa_output.hdmi\n')
  expect(args).toContain('alsa_output.hdmi')
  expect(args.join(' ')).toContain('stream.capture.sink = true')
  expect(args.join(' ')).toContain('node.dont-reconnect = true')
  expect(() => monitorArgs('')).toThrow()
})
it('omits --raw for pw-cat builds that do not support it (PipeWire 1.0.x)', () => {
  expect(monitorArgs('alsa_output.hdmi')).toContain('--raw')
  expect(monitorArgs('alsa_output.hdmi', false)).not.toContain('--raw')
  expect(monitorArgs('alsa_output.hdmi', false)).toContain('--record')
})
it('aligns initial silence on stereo PCM frame boundaries', () => {
  expect(leadingSilence(1000, 1100, 3840)).toBe(15360)
  expect(leadingSilence(1000, 1000, 3840)).toBe(0)
  expect(leadingSilence(1000, 1101, 3840) % 4).toBe(0)
})
