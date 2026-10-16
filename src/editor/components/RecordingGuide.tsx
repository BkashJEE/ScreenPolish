import { useEffect, useState } from 'react'
import type { GuideView } from '../../shared/ipc'
import { cx } from './ui'

/**
 * The recording guide: while a planned take records a window or a region,
 * this window stays beside it and shows the step being done in large type,
 * the caption that part of the video will carry, and what comes next. Each
 * click in the recording moves it on; Back and Next fix a step the clicks
 * got wrong. Clicking here is outside the recording, so it is never seen.
 */
export function RecordingGuide() {
  const [view, setView] = useState<GuideView | null>(null)

  useEffect(() => {
    void window.polish.guideState().then(setView).catch(() => setView(null))
    return window.polish.onGuideChanged(setView)
  }, [])

  if (!view || !view.onScreen) return null
  const step = view.steps[view.index]
  const next = view.steps[view.index + 1]
  const last = view.index >= view.steps.length - 1

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-5 overflow-y-auto bg-bg-0 p-6 text-fg" role="region" aria-label="Recording guide">
      <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-fg-muted">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" aria-hidden="true" />
        Recording · step {view.index + 1} of {view.steps.length}
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-[clamp(20px,3.2vw,34px)] font-semibold leading-tight" aria-live="polite">
          {step?.action}
        </p>
        {step?.caption && (
          <div className="self-start rounded-[10px] border border-accent/50 bg-bg-2 px-3 py-2">
            <div className="text-[10.5px] uppercase tracking-wide text-fg-dim">Caption on screen</div>
            <div className="text-[15px] text-fg">“{step.caption}”</div>
          </div>
        )}
      </div>

      {next && (
        <div className="text-[13px] text-fg-muted">
          <span className="text-fg-dim">Then: </span>
          {next.action}
        </div>
      )}
      {last && <div className="text-[13px] text-fg-muted">Last step. Stop the recording when you are done.</div>}

      <div className="flex items-center gap-2">
        <button type="button" className="rounded-[8px] border border-line-strong px-3 py-1.5 text-[13px] hover:bg-bg-2 disabled:opacity-40" disabled={view.index === 0} onClick={() => void window.polish.guideMove('back')}>
          ‹ Back
        </button>
        <button type="button" className="rounded-[8px] border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" disabled={last} onClick={() => void window.polish.guideMove('next')}>
          Next ›
        </button>
        <span className="text-[12px] text-fg-dim">Each click in the recording moves to the next step.</span>
      </div>

      <ol className="mt-1 flex flex-col gap-1 border-t border-line pt-3 text-[12.5px]" aria-label="All steps">
        {view.steps.map((s, i) => (
          <li key={i} className={cx('grid grid-cols-[22px_1fr] gap-1.5', i < view.index ? 'text-fg-dim line-through' : i === view.index ? 'font-medium text-fg' : 'text-fg-muted')}>
            <span className="font-mono">{i + 1}</span>
            <span>{s.action}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
