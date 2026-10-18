import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeCaptions } from '../../shared/captions'
import { takeOutput } from '../../shared/take-time'
import type { Project } from '../../shared/types'
import { addVoiceoverClip, replaceCuesIn, voiceAt, voiceoverCues, type VoiceoverClip } from '../../shared/voiceover'
import { formatTime } from '../lib/time'
import { Mic, Spinner, Trash } from './icons'
import { Button, IconButton, Row, Select, SliderField, Toggle } from './ui'

/**
 * Voiceover in the editor: record your voice over the take while it plays,
 * hear it back in the preview, and get captions from it.
 *
 * The take plays from the playhead while the microphone records; stopping
 * (or the take reaching its end) saves the recording beside the take and puts
 * it on the take's output clock where it began. The preview's own sound is
 * muted while recording, so speakers do not leak into the microphone, unless
 * "Hear the take" is on. Captions are then transcribed from the voice, on
 * this computer, and replace whatever captions that stretch had.
 */

export type VoiceoverPhase = 'idle' | 'starting' | 'recording' | 'saving' | 'captioning'

export interface VoiceoverControls {
  phase: VoiceoverPhase
  /** Seconds recorded so far. */
  elapsed: number
  error: string | null
  note: string | null
  mics: MediaDeviceInfo[]
  mic: string
  setMic: (id: string) => void
  hearTake: boolean
  setHearTake: (on: boolean) => void
  canCaption: boolean
  start: () => void
  stop: () => void
  /** Transcribe one clip again and replace its captions. */
  caption: (clip: VoiceoverClip) => void
}

const VOICE_SYNC_SEC = 0.25
/** The take's other sound under a playing voice, in the preview, when ducking is on. */
const PREVIEW_DUCK = 0.3

export function voiceUrl(screenUrl: string, file: string): string {
  return screenUrl.replace(/screen\.mp4$/, encodeURIComponent(file))
}

export function useVoiceover(args: {
  folder: string
  project: Project
  onProject: (update: (p: Project) => Project) => void
  time: number
  playing: boolean
  setPlaying: (p: boolean) => void
  duration: number
  canCaption: boolean
}) {
  const { folder, project, onProject, time, playing, setPlaying, duration, canCaption } = args
  const [phase, setPhase] = useState<VoiceoverPhase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [mic, setMic] = useState('')
  const [hearTake, setHearTake] = useState(false)
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedWall: number; startSource: number; atSec: number; anchored: boolean } | null>(null)
  const latest = useRef({ project, duration })
  latest.current = { project, duration }

  const output = useMemo(() => (Number.isFinite(duration) && duration > 0 ? takeOutput(project, duration) : null), [project, duration])
  const clips = useMemo(() => project.voiceover ?? [], [project.voiceover])

  useEffect(() => {
    const list = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setMics(d.filter((x) => x.kind === 'audioinput')))
        .catch(() => setMics([]))
    void list()
    navigator.mediaDevices?.addEventListener?.('devicechange', list)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', list)
  }, [])

  const caption = useCallback(
    async (clip: VoiceoverClip) => {
      if (!canCaption) return
      setPhase('captioning')
      try {
        const cues = await window.polish.transcribeVoiceover(folder, clip.file)
        const { project: p, duration: d } = latest.current
        const out = takeOutput(p, d)
        const toSource = (t: number): number | null => {
          const f = out.at(t)
          return f.kind === 'recording' && 'sourceSec' in f ? f.sourceSec : null
        }
        const fresh = voiceoverCues(cues, clip, toSource)
        const from = toSource(clip.atSec) ?? 0
        const to = toSource(clip.atSec + clip.durationSec) ?? d
        onProject((cur) => {
          const c = normalizeCaptions(cur.captions)
          return { ...cur, captions: { ...c, enabled: true, cues: replaceCuesIn(c.cues, from, to, fresh) } }
        })
        setNote(fresh.length ? `Captions made from your voice: ${fresh.length} ${fresh.length === 1 ? 'line' : 'lines'}.` : 'No speech was found in that voiceover.')
      } catch (e) {
        setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      } finally {
        setPhase('idle')
      }
    },
    [canCaption, folder, onProject]
  )

  const finish = useCallback(async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    setPlaying(false)
    const stopped = new Promise<void>((resolve) => {
      r.recorder.onstop = () => resolve()
    })
    if (r.recorder.state !== 'inactive') r.recorder.stop()
    await stopped
    r.stream.getTracks().forEach((t) => t.stop())
    setPhase('saving')
    try {
      const data = await new Blob(r.chunks, { type: 'audio/webm' }).arrayBuffer()
      const saved = await window.polish.saveVoiceover(folder, data)
      const clip: VoiceoverClip = { id: saved.file.replace(/^voiceover-|\.m4a$/g, ''), file: saved.file, atSec: Math.max(0, r.atSec), durationSec: saved.durationSec, volume: 1 }
      const replaced = addVoiceoverClip(latest.current.project.voiceover ?? [], clip).replaced.length
      onProject((cur) => ({ ...cur, voiceover: addVoiceoverClip(cur.voiceover ?? [], clip).clips }))
      setNote(`Recorded ${formatTime(clip.durationSec)} at ${formatTime(clip.atSec)}${replaced ? `, replacing ${replaced} earlier ${replaced === 1 ? 'one' : 'ones'}` : ''}.`)
      if (canCaption) await caption(clip)
      else setPhase('idle')
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setPhase('idle')
    }
  }, [canCaption, caption, folder, onProject, setPlaying])

  const start = useCallback(async () => {
    if (phase !== 'idle' || !output) return
    setError(null)
    setNote(null)
    setPhase('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(mic ? { deviceId: { exact: mic } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 160_000 })
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.start(250)
      rec.current = { recorder, stream, chunks, startedWall: performance.now(), startSource: time, atSec: output.fromSource(time), anchored: false }
      setElapsed(0)
      setPhase('recording')
      setPlaying(true)
    } catch (e) {
      setPhase('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'The microphone is not allowed. Allow it, then try again.' : (e instanceof Error ? e.message : String(e)))
    }
  }, [mic, output, phase, setPlaying, time])

  // The preview takes a moment to start moving: the voice is placed where the
  // picture really was when the recording began, measured from its first move.
  useEffect(() => {
    const r = rec.current
    if (!r || phase !== 'recording' || !output) return
    setElapsed((performance.now() - r.startedWall) / 1000)
    if (!r.anchored && Math.abs(time - r.startSource) > 1e-3) {
      r.anchored = true
      r.atSec = Math.max(0, output.fromSource(time) - (performance.now() - r.startedWall) / 1000)
    }
  }, [time, phase, output])

  // The take reaching its end, or a pause, ends the recording.
  useEffect(() => {
    if (phase === 'recording' && !playing && rec.current && performance.now() - rec.current.startedWall > 400) void finish()
  }, [playing, phase, finish])

  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), [])

  // What the preview plays: the take muted while recording, and lowered under a playing voice.
  const outputTime = output ? output.fromSource(time) : 0
  const speaking = !!voiceAt(clips, outputTime)
  const previewProject = useMemo(() => {
    const master = project.audio.masterVolume ?? 1
    if (phase === 'recording' && !hearTake) return { ...project, audio: { ...project.audio, masterVolume: 0 } }
    if (speaking && project.audio.duckUnderVoice !== false) return { ...project, audio: { ...project.audio, masterVolume: master * PREVIEW_DUCK } }
    return project
  }, [project, phase, hearTake, speaking])

  const controls: VoiceoverControls = {
    phase,
    elapsed,
    error,
    note,
    mics,
    mic,
    setMic,
    hearTake,
    setHearTake,
    canCaption,
    start: () => void start(),
    stop: () => void finish(),
    caption: (clip) => void caption(clip)
  }
  return { controls, previewProject, outputTime, recording: phase === 'recording' }
}

/** Plays the voiceover clips in step with the preview. */
export function VoiceoverPlayer({ clips, screenUrl, outputTime, playing, muted, master }: { clips: VoiceoverClip[]; screenUrl: string; outputTime: number; playing: boolean; muted: boolean; master: number }) {
  const refs = useRef(new Map<string, HTMLAudioElement>())
  useEffect(() => {
    for (const clip of clips) {
      const el = refs.current.get(clip.id)
      if (!el) continue
      const local = outputTime - clip.atSec
      const inside = local >= 0 && local < clip.durationSec
      el.volume = Math.min(1, Math.max(0, clip.volume * master))
      if (!inside || !playing || muted) {
        if (!el.paused) el.pause()
        if (inside && Math.abs(el.currentTime - local) > VOICE_SYNC_SEC) el.currentTime = local
        continue
      }
      if (Math.abs(el.currentTime - local) > VOICE_SYNC_SEC) el.currentTime = local
      if (el.paused) void el.play().catch(() => undefined)
    }
  }, [clips, outputTime, playing, muted, master])
  return (
    <>
      {clips.map((clip) => (
        <audio
          key={clip.id}
          ref={(el) => {
            if (el) refs.current.set(clip.id, el)
            else refs.current.delete(clip.id)
          }}
          src={voiceUrl(screenUrl, clip.file)}
          preload="auto"
        />
      ))}
    </>
  )
}

/** The Voiceover section: record, the clips, and how they sit in the mix. */
export function VoiceoverPanel({ controls: c, project, onProject }: { controls: VoiceoverControls; project: Project; onProject: (update: (p: Project) => Project) => void }) {
  const clips = project.voiceover ?? []
  const busy = c.phase === 'saving' || c.phase === 'captioning' || c.phase === 'starting'
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] leading-[1.4] text-fg-muted">
        Talk over the take while it plays from the playhead. Your recording is kept beside the take{c.canCaption ? ', and captions are made from your voice on this computer' : ''}.
      </p>
      {c.mics.length > 1 && (
        <Row label="Microphone">
          <Select<string>
            ariaLabel="Voiceover microphone"
            className="w-[170px]"
            value={c.mic}
            onChange={c.setMic}
            options={[{ value: '', label: 'Default' }, ...c.mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` }))]}
          />
        </Row>
      )}
      <div className="flex items-center gap-2">
        {c.phase === 'recording' ? (
          <Button size="sm" variant="danger" onClick={c.stop}>
            ■ Stop · {formatTime(c.elapsed, { fraction: false })}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : <Mic size={13} />} disabled={busy} onClick={c.start}>
            {c.phase === 'saving' ? 'Saving…' : c.phase === 'captioning' ? 'Making captions…' : 'Record voiceover from here'}
          </Button>
        )}
      </div>
      <Row label="Hear the take while recording" hint="Off keeps the speakers out of the microphone; turn on with headphones.">
        <Toggle checked={c.hearTake} onChange={c.setHearTake} label="Hear the take while recording" />
      </Row>
      <Row label="Lower other sound while I talk">
        <Toggle checked={project.audio.duckUnderVoice !== false} onChange={(on) => onProject((p) => ({ ...p, audio: { ...p.audio, duckUnderVoice: on } }))} label="Lower other sound while I talk" />
      </Row>
      {c.error && <p className="text-[11px] text-danger">{c.error}</p>}
      {c.note && !c.error && <p className="text-[11px] text-fg-muted">{c.note}</p>}
      {clips.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Voiceover clips">
          {clips.map((clip) => (
            <li key={clip.id} className="flex flex-col gap-1 rounded-[8px] border border-line-strong px-2.5 py-2">
              <div className="flex items-center gap-2 text-[12px]">
                <Mic size={12} className="text-fg-muted" />
                <span className="font-mono tabular-nums">
                  {formatTime(clip.atSec)} – {formatTime(clip.atSec + clip.durationSec)}
                </span>
                {c.canCaption && (
                  <Button size="sm" className="ml-auto" disabled={busy || c.phase === 'recording'} title="Transcribe this voiceover again and replace its captions" onClick={() => c.caption(clip)}>
                    Captions
                  </Button>
                )}
                <IconButton label="Remove this voiceover" size={24} tone="danger" className={c.canCaption ? '' : 'ml-auto'} onClick={() => onProject((p) => ({ ...p, voiceover: (p.voiceover ?? []).filter((v) => v.id !== clip.id) }))}>
                  <Trash size={13} />
                </IconButton>
              </div>
              <SliderField label="Volume" value={clip.volume} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(volume) => onProject((p) => ({ ...p, voiceover: (p.voiceover ?? []).map((v) => (v.id === clip.id ? { ...v, volume } : v)) }))} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
