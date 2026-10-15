import { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'
import { CAPTION_SIZE_RANGE, CAPTIONS_NOT_INSTALLED, DEFAULT_CAPTIONS, DEFAULT_CAPTION_HIGHLIGHT, editCue, normalizeCaptions, type CaptionPosition, type CaptionSettings, type CaptionStyle, type CaptionsStatus } from '../../shared/captions'
import { projectSrt } from '../lib/captions-srt'
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
  sources
}: {
  project: Project
  onProject: (update: (p: Project) => Project) => void
  folder: string
  /** Seconds of recording, for timing the .srt to the export. */
  duration: number
  sources: Source[]
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

  const patch = (update: Partial<CaptionSettings>) =>
    onProject((p) => ({ ...p, captions: { ...normalizeCaptions(p.captions), ...update } }))

  if (status && !status.installed) {
    return (
      <div className="flex flex-col gap-1.5" role="status">
        <p className="text-[11px] text-fg">{CAPTIONS_NOT_INSTALLED}</p>
        {status.reason && <p className="text-[11px] text-fg-dim">{status.reason.replace(CAPTIONS_NOT_INSTALLED, '').trim()}</p>}
        {captions.cues.length > 0 && <p className="text-[11px] text-fg-dim">The {captions.cues.length} lines already in this project still export.</p>}
      </div>
    )
  }

  if (sources.length === 0) {
    return <p className="text-[11px] text-fg-dim">This recording has no audio track, so there is nothing to transcribe.</p>
  }

  const run = async () => {
    setError(null)
    setProgress(0)
    try {
      const cues = await window.polish.transcribe(folder, source)
      if (cues.length === 0) setError('No speech was found in that track.')
      else patch({ cues, enabled: true })
    } catch (e) {
      // Electron prefixes errors thrown in main; the user only needs the reason.
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] text-fg-muted">
        Transcribed on this computer, nothing is uploaded. Fix any word below and the video follows.
      </p>
      {sources.length > 1 && (
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
      <div className="flex items-center gap-2">
        <Button size="sm" variant={captions.cues.length ? 'default' : 'primary'} disabled={busy || status === null} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void run()}>
          {busy ? `Transcribing ${Math.round((progress ?? 0) * 100)}%` : captions.cues.length ? 'Transcribe again' : 'Transcribe'}
        </Button>
        {captions.cues.length > 0 && !busy && <span className="text-[11px] text-fg-dim">replaces your edits</span>}
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}

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
