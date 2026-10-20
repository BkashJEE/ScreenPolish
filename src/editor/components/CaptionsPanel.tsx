import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../shared/types'
import { CAPTION_SIZE_RANGE, CAPTIONS_NOT_INSTALLED, DEFAULT_CAPTIONS, DEFAULT_CAPTION_HIGHLIGHT, editCue, normalizeCaptions, type CaptionPosition, type CaptionSettings, type CaptionStyle, type CaptionsStatus } from '../../shared/captions'
import { projectSrt } from '../lib/captions-srt'
import { scriptCues, stepTimes, type ScriptTiming } from '../../shared/caption-script'
import { FILLER_CUT_PREFIX, fillerSummary, findFillers } from '../../shared/fillers'
import { removeSilences, restoreSilences } from '../../shared/silence'
import { effectiveTrim } from '../../shared/layout'
import { formatTime } from '../lib/time'
import { Spinner } from './icons'
import { Button, Chip, ColorField, Row, Segmented, SliderField, Toggle } from './ui'

type Source = 'mic' | 'system'

/**
 * Transcribe the take on this machine, correct the text, and burn it in. The
 * cues are in source time, so removed clips take their captions with them.
 */
export function CaptionsPanel({
  project,
  onProject,
  folder,
  duration,
  sources,
  clicks = [],
  stepMarks
}: {
  project: Project
  onProject: (update: (p: Project) => Project) => void
  folder: string
  /** Seconds of recording, for timing the .srt to the export. */
  duration: number
  sources: Source[]
  /** Source seconds of each mouse press. */
  clicks?: number[]
  /** Source seconds at which each step of a guided take began; absent when the take had no guide. */
  stepMarks?: number[]
}) {
  const captions = normalizeCaptions(project.captions ?? DEFAULT_CAPTIONS)
  const [source, setSource] = useState<Source>(sources[0] ?? 'mic')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null until main answers; a build without the engine says so here rather
  // than failing when Transcribe is pressed.
  const [status, setStatus] = useState<CaptionsStatus | null>(null)
  const busy = progress !== null
  const [saved, setSaved] = useState<string | null>(null)
  const style = captions.style ?? 'box'

  const saveSrt = async () => {
    setError(null)
    setSaved(null)
    try {
      const path = await window.polish.saveCaptions(folder, project.title.trim() || 'captions', projectSrt(project, duration))
      setSaved(path)
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  useEffect(() => (busy ? window.polish.onTranscribeProgress((f) => setProgress(f)) : undefined), [busy])
  useEffect(() => {
    let live = true
    window.polish.captionsStatus().then(
      (s) => live && setStatus(s),
      // An older bridge without the call: let transcribe report the problem.
      () => live && setStatus({ installed: true, reason: null })
    )
    return () => {
      live = false
    }
  }, [])

  // `auto` goes in the same edit as the result, so one undo takes both back.
  const patch = (update: Partial<CaptionSettings>) =>
    onProject((p) => {
      const { auto: _auto, ...rest } = normalizeCaptions(p.captions)
      return { ...p, captions: { ...rest, ...update } }
    })

  const run = async (from: Source = source, auto = false) => {
    setError(null)
    setProgress(0)
    try {
      const cues = await window.polish.transcribe(folder, from)
      if (cues.length === 0) {
        setError(auto ? 'Tried to make captions by themselves, but no speech was found in the microphone.' : 'No speech was found in that track.')
        if (auto) patch({})
      } else patch({ cues, enabled: true })
    } catch (e) {
      // Electron prefixes errors thrown in main; the user only needs the reason.
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      if (auto) patch({})
    } finally {
      setProgress(null)
    }
  }

  // A new take that asked for captions gets them once, when first opened: from its voice when it
  // has one, otherwise from the script planned before it was recorded, timed to its clicks.
  const autoTried = useRef<string | null>(null)
  useEffect(() => {
    if (!captions.auto || busy || !status || autoTried.current === folder || captions.cues.length > 0) return
    const voice = status.installed && sources.includes('mic')
    // A guided take keeps its planned lines even with a voice; Transcribe is still there.
    if ((!voice || captions.scriptTiming === 'steps') && captions.script) {
      // The take's length arrives after the project; the script is timed against it.
      if (duration <= 0) return
      autoTried.current = folder
      const cues = scriptCues(captions.script, effectiveTrim(project, duration), captions.scriptTiming ?? 'clicks', clicks, `script-${Date.now().toString(36)}`, stepMarks)
      if (cues.length) patch({ cues, enabled: true })
      return
    }
    autoTried.current = folder
    // Without a voice or a script there is nothing to try; the flag stays, unused, rather than adding an edit nobody made.
    if (voice) void run('mic', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captions.auto, status, folder, duration])

  const engineMissing = status !== null && !status.installed
  // A script needs neither a voice nor the engine, so it is offered whatever this take has.
  const canTranscribe = !engineMissing && sources.length > 0

  return (
    <div className="flex flex-col gap-2.5">
      {engineMissing && (
        <div className="flex flex-col gap-1.5" role="status">
          <p className="text-[11px] text-fg">{CAPTIONS_NOT_INSTALLED}</p>
          {status.reason && <p className="text-[11px] text-fg-dim">{status.reason.replace(CAPTIONS_NOT_INSTALLED, '').trim()}</p>}
        </div>
      )}
      {!engineMissing && sources.length === 0 && (
        <p className="text-[11px] text-fg-dim">This recording has no sound, so there is nothing to transcribe. Write what it shows below, or turn the microphone on in Capture before the next take.</p>
      )}
      {canTranscribe && (
        <p className="text-[11px] text-fg-muted">
          Transcribed on this computer, nothing is uploaded. Fix any word below and the video follows.
        </p>
      )}
      {canTranscribe && sources.length > 1 && (
        <Segmented<Source>
          size="sm"
          value={source}
          onChange={setSource}
          options={[
            { value: 'mic', label: 'Microphone', title: 'Transcribe your voice.' },
            { value: 'system', label: 'System audio', title: 'Transcribe what the computer played.' }
          ]}
        />
      )}
      {canTranscribe && (
      <div className="flex items-center gap-2">
        <Button size="sm" variant={captions.cues.length ? 'default' : 'primary'} disabled={busy || status === null} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void run()}>
          {busy ? `Transcribing ${Math.round((progress ?? 0) * 100)}%` : captions.cues.length ? 'Transcribe again' : 'Transcribe'}
        </Button>
        {captions.cues.length > 0 && !busy && <span className="text-[11px] text-fg-dim">replaces your edits</span>}
      </div>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <ScriptBox
        key={folder}
        captions={captions}
        clicks={clicks}
        stepMarks={stepMarks}
        range={effectiveTrim(project, duration)}
        open={!canTranscribe || !!captions.script}
        disabled={busy || duration <= 0}
        onMake={(script, timing, cues) => {
          setError(null)
          patch({ cues, enabled: true, script, scriptTiming: timing })
        }}
      />

      {captions.cues.length > 0 && (
        <>
          <Row label="Show in video">
            <Toggle checked={captions.enabled} onChange={(enabled) => patch({ enabled })} label="Show captions in video" />
          </Row>
          <Row label="Style">
            <Segmented<CaptionStyle>
              full={false}
              size="sm"
              value={style}
              onChange={(next) => patch({ style: next })}
              options={[
                { value: 'box', label: 'Box', title: 'The line on a dark box' },
                { value: 'karaoke', label: 'Karaoke', title: 'Each word lights up as it is said' },
                { value: 'bold', label: 'Bold', title: 'Big capitals, a few words at a time' },
                { value: 'minimal', label: 'Minimal', title: 'White text with a soft shadow' }
              ]}
            />
          </Row>
          {(style === 'karaoke' || style === 'bold') && (
            <Row label="Highlight">
              <ColorField label="Highlight colour" value={captions.highlight ?? DEFAULT_CAPTION_HIGHLIGHT} onChange={(highlight) => patch({ highlight })} />
            </Row>
          )}
          <Row label="Position">
            <Segmented<CaptionPosition>
              full={false}
              size="sm"
              value={captions.position}
              onChange={(position) => patch({ position })}
              options={[
                { value: 'bottom', label: 'Bottom' },
                { value: 'top', label: 'Top' }
              ]}
            />
          </Row>
          <SliderField
            label="Text size"
            value={captions.size}
            min={CAPTION_SIZE_RANGE.min}
            max={CAPTION_SIZE_RANGE.max}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(size) => patch({ size })}
          />
          <div className="flex items-center gap-2">
            <Chip tone="info">{captions.cues.length} lines</Chip>
            <Button size="sm" className="ml-auto" title="A subtitle file timed to the export, for YouTube and other players" onClick={() => void saveSrt()}>
              Export .srt
            </Button>
          </div>
          <FillerRow project={project} onProject={onProject} duration={duration} />
          {saved && (
            <p className="text-[11px] text-fg-muted">
              Saved{' '}
              <button type="button" className="underline hover:text-fg" onClick={() => void window.polish.reveal(saved)}>
                {saved.split('/').pop()}
              </button>
              , timed to the export.
            </p>
          )}
          <ol className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto pr-1" aria-label="Caption lines">
            {captions.cues.map((cue) => (
              <li key={cue.id} className="flex flex-col gap-1">
                <span className="font-mono text-[10.5px] tabular-nums text-fg-dim">
                  {formatTime(cue.start)} – {formatTime(cue.end)}
                </span>
                <textarea
                  aria-label={`Caption at ${formatTime(cue.start)}`}
                  className="min-h-[34px] resize-y rounded-[7px] border border-line-strong bg-bg-1 px-2 py-1.5 text-[12px] leading-[1.35] text-fg focus:border-accent"
                  style={{ userSelect: 'text' }}
                  rows={1}
                  defaultValue={cue.text}
                  onKeyDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const text = e.target.value
                    if (text !== cue.text) patch({ cues: editCue(captions.cues, cue.id, text) })
                  }}
                />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

/**
 * Remove filler words: every "um" and "uh" the transcriber marked becomes a
 * cut, tagged so the whole set can be put back. Running it again replaces the
 * previous set; the user's own cuts are never touched.
 */
function FillerRow({ project, onProject, duration }: { project: Project; onProject: (update: (p: Project) => Project) => void; duration: number }) {
  const found = findFillers(normalizeCaptions(project.captions).cues)
  const removed = fillerSummary(project.cuts)
  if (removed.count === 0 && found.length === 0) return <p className="text-[11px] text-fg-dim">No filler words (um, uh) were found.</p>
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-fg-muted">
        {removed.count > 0
          ? `${removed.count} filler ${removed.count === 1 ? 'word' : 'words'} cut (${removed.seconds.toFixed(1)} s)`
          : `${found.length} filler ${found.length === 1 ? 'word' : 'words'} found: ${[...new Set(found.map((f) => f.word.toLowerCase()))].slice(0, 4).join(', ')}`}
      </span>
      {removed.count > 0 ? (
        <Button size="sm" className="ml-auto" onClick={() => onProject((p) => ({ ...p, ...restoreSilences(p.cuts, p.splits, FILLER_CUT_PREFIX) }))}>
          Put back
        </Button>
      ) : (
        <Button
          size="sm"
          className="ml-auto"
          onClick={() =>
            onProject((p) => {
              const clean = restoreSilences(p.cuts, p.splits, FILLER_CUT_PREFIX)
              return { ...p, ...removeSilences(found, clean.cuts, clean.splits, effectiveTrim(p, duration), FILLER_CUT_PREFIX) }
            })
          }
        >
          Remove filler words
        </Button>
      )}
    </div>
  )
}

/**
 * Captions from a script: write or paste what the take shows, one caption per
 * line, and it is timed to the clicks or spread over the take. The script is
 * kept with the project, so it can be changed and made again.
 */
function ScriptBox({
  captions,
  clicks,
  stepMarks,
  range,
  open,
  disabled,
  onMake
}: {
  captions: CaptionSettings
  clicks: number[]
  stepMarks?: number[]
  range: { start: number; end: number }
  open: boolean
  disabled: boolean
  onMake: (script: string, timing: ScriptTiming, cues: CaptionSettings['cues']) => void
}) {
  const steps = stepTimes(clicks, range).length
  const [text, setText] = useState(captions.script ?? '')
  // Until chosen, follow the take: the length (and so its steps) can arrive after this mounts.
  const [chosen, setTiming] = useState<ScriptTiming | null>(captions.scriptTiming ?? null)
  const timing: ScriptTiming = chosen ?? (stepMarks ? 'steps' : steps > 0 ? 'clicks' : 'even')
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length
  const make = () => {
    const cues = scriptCues(text, range, timing, clicks, `script-${Date.now().toString(36)}`, stepMarks)
    if (cues.length) onMake(text, timing, cues)
  }
  return (
    <details className="group flex flex-col gap-2 rounded-[8px] border border-line-strong px-2.5 py-2" open={open}>
      <summary className="cursor-pointer select-none text-[12px] text-fg">Captions from a script</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-[11px] leading-[1.4] text-fg-muted">One caption per line. Long lines are split where a sentence ends.</p>
        <textarea
          aria-label="Caption script"
          className="min-h-[96px] resize-y rounded-[7px] border border-line-strong bg-bg-1 px-2 py-1.5 text-[12px] leading-[1.4] text-fg focus:border-accent"
          style={{ userSelect: 'text' }}
          rows={5}
          placeholder={'Open Footprint\nPick the profile to check\nThe biggest folders are on the left'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Row label="Timing" hint={timing === 'steps' ? 'Line N starts when step N began while recording; a blank line is a step without a caption.' : timing === 'clicks' ? (steps ? `Each line starts at a click; ${steps} ${steps === 1 ? 'step' : 'steps'} in this take.` : 'No clicks in this take, so the lines are spread evenly.') : 'Spread evenly over the take.'}>
          <Segmented<ScriptTiming>
            full={false}
            size="sm"
            value={timing}
            onChange={setTiming}
            options={[
              ...(stepMarks ? [{ value: 'steps' as const, label: 'At steps', title: 'Line N starts when step N of the recording guide began' }] : []),
              { value: 'clicks', label: 'At clicks', title: 'Each line starts at a click' },
              { value: 'even', label: 'Evenly', title: 'Lines spread evenly over the take' }
            ]}
          />
        </Row>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={captions.cues.length ? 'default' : 'primary'} disabled={disabled || lines === 0} onClick={make}>
            {captions.script ? 'Make captions again' : 'Make captions'}
          </Button>
          {captions.cues.length > 0 && <span className="text-[11px] text-fg-dim">replaces the captions</span>}
        </div>
      </div>
    </details>
  )
}
