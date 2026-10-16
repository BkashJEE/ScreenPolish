import { useEffect, useRef, useState } from 'react'
import type { SourceInfo } from '../../shared/ipc'
import type { PlanTurn, RecordPlan } from '../../shared/record-plan'
import { planContextFrom } from '../lib/plan-apply'
import { formatTime } from '../lib/time'
import { ChevronDown, ChevronRight, Spinner } from './icons'
import { Button, Chip, Select } from './ui'

const AGENT_KEY = 'polish.plan.agent'

/**
 * Plan a recording with an agent before pressing Record. You say what the
 * video is for; the agent answers with an angle, a length, a shot list, a look
 * and the intro and outro cards, and Apply puts all of it into the panel and
 * onto the next take. The agent runs as its own command line, once per
 * message, with its tools off; ScreenPolish itself sends nothing anywhere.
 */
export function PlanPanel({
  sources,
  hasMic,
  hasWebcam,
  onApply,
  onRecord,
  onClear,
  disabled
}: {
  sources: SourceInfo[] | null
  hasMic: boolean
  hasWebcam: boolean
  onApply: (plan: RecordPlan) => Promise<string[]>
  /** Apply, then record the plan's length and stop by itself. */
  onRecord?: (plan: RecordPlan) => Promise<string[]>
  /** The plan was thrown away: the next take is an ordinary one again. */
  onClear?: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [agents, setAgents] = useState<Array<{ id: string; name: string }> | null>(null)
  const [agentId, setAgentId] = useState(() => {
    try {
      return localStorage.getItem(AGENT_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [turns, setTurns] = useState<PlanTurn[]>([])
  const [draft, setDraft] = useState('')
  const [plan, setPlan] = useState<RecordPlan | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<string[] | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.polish
      .planAgents()
      .then((list) => {
        setAgents(list)
        setAgentId((id) => (list.some((a) => a.id === id) ? id : (list[0]?.id ?? '')))
      })
      .catch(() => setAgents([]))
  }, [])

  useEffect(() => {
    try {
      if (agentId) localStorage.setItem(AGENT_KEY, agentId)
    } catch {
      // storage unavailable: the first agent is picked next time
    }
  }, [agentId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [turns, asking])

  const agentName = agents?.find((a) => a.id === agentId)?.name ?? 'the agent'

  const ask = async () => {
    const text = draft.trim()
    if (!text || !agentId || asking) return
    const history: PlanTurn[] = [...turns, { role: 'user', text }]
    setTurns(history)
    setDraft('')
    setError(null)
    setApplied(null)
    setAsking(true)
    try {
      const reply = await window.polish.askPlan(agentId, planContextFrom(sources ?? [], hasMic, hasWebcam), history)
      setTurns([...history, { role: 'agent', text: reply.message || (reply.plan ? 'Here is a plan.' : '(no answer)') }])
      if (reply.plan) setPlan(reply.plan)
      else setError(`${agentName} answered without a plan. Ask again, or say a bit more about the video.`)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setAsking(false)
    }
  }

  const reset = () => {
    setTurns([])
    setPlan(null)
    setError(null)
    setApplied(null)
    onClear?.()
  }

  return (
    <div className="plan-panel border-t border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <button type="button" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Plan with an agent
        </button>
        {plan && <Chip tone="ok">Plan ready</Chip>}
        <div className="ml-auto flex items-center gap-1.5">
          {agents && agents.length > 0 && (
            <Select ariaLabel="Agent" value={agentId} options={agents.map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} disabled={asking} />
          )}
          {turns.length > 0 && (
            <Button size="sm" variant="ghost" onClick={reset} disabled={asking}>
              New plan
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {agents && agents.length === 0 && (
            <p className="text-[12px] leading-[1.45] text-fg/80">
              No agent found. Install Claude Code or Codex, or add your own in <span className="font-mono">plan-agents.json</span> in ScreenPolish's settings folder.
            </p>
          )}

          {turns.length === 0 && agents && agents.length > 0 && (
            <p className="text-[12px] leading-[1.45] text-fg/80">
              Say what the video is for — "a 30-second demo of exporting a GIF, for X" — and {agentName} suggests the angle, length, shot list, look and title cards. Nothing is recorded until you press Record.
            </p>
          )}

          {turns.length > 0 && (
            <div ref={logRef} className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
              {turns.map((t, i) => (
                <div
                  key={i}
                  className={
                    t.role === 'user'
                      ? 'self-end max-w-[85%] rounded-[10px] bg-bg-3 px-2.5 py-1.5 text-[12.5px] text-fg'
                      : 'self-start max-w-[92%] text-[12.5px] leading-[1.45] text-fg/80 whitespace-pre-wrap'
                  }
                  style={{ userSelect: 'text' }}
                >
                  {t.role === 'agent' && <span className="mr-1 font-semibold text-fg">{agentName}:</span>}
                  {t.text}
                </div>
              ))}
              {asking && (
                <div className="flex items-center gap-2 text-[12px] text-fg-muted">
                  <Spinner size={12} /> {agentName} is planning — usually 15 to 40 seconds.
                </div>
              )}
            </div>
          )}

          {plan && <PlanCard plan={plan} />}

          {plan && onRecord && (
            <div className="flex flex-col gap-1.5">
              <Button
                variant="record"
                disabled={asking || disabled}
                onClick={() => void onRecord(plan).then(setApplied).catch((e: unknown) => setError(String(e)))}
              >
                ● Record this plan · {formatTime(plan.durationSec, { fraction: false })}
              </Button>
              <p className="text-[11.5px] leading-[1.45] text-fg-muted">
                Read the shot list first: this window steps aside while recording. It counts in, records {formatTime(plan.durationSec, { fraction: false })} and stops by
                itself; the title cards are added to the take.
              </p>
            </div>
          )}

          {error && <p className="text-[12px] text-danger">{error}</p>}
          {applied && (
            <div className="text-[12px] leading-[1.45] text-fg/80">
              <span className="text-ok">Applied.</span> The source, inputs and pointer are set, and the next take gets the cards{plan?.look.background ? ', background' : ''}
              {plan?.look.aspect ? ' and shape' : ''}. Press Record when ready.
              {applied.map((n, i) => (
                <p key={i} className="mt-1 text-manual">{n}</p>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              aria-label="Describe the recording"
              className="min-h-[34px] flex-1 resize-none rounded-[8px] border border-line-strong bg-bg-1 px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-muted focus:border-accent"
              style={{ userSelect: 'text' }}
              rows={turns.length ? 1 : 2}
              placeholder={turns.length ? 'Change something: shorter, vertical, no intro…' : 'What do you want to record, and where will it be posted?'}
              value={draft}
              disabled={asking || !agentId}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void ask()
                }
              }}
            />
            <Button size="sm" variant={plan ? 'default' : 'primary'} onClick={() => void ask()} disabled={asking || !draft.trim() || !agentId}>
              {asking ? <Spinner size={12} /> : turns.length ? 'Send' : 'Plan it'}
            </Button>
            {plan && (
              <Button
                size="sm"
                variant="default"
                disabled={asking || disabled}
                onClick={() => void onApply(plan).then(setApplied).catch((e: unknown) => setError(String(e)))}
              >
                Apply only
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PlanCard({ plan }: { plan: RecordPlan }) {
  const look = plan.look
  const lookBits = [
    look.aspect,
    look.fps ? `${look.fps} fps` : null,
    look.pointer ? `${look.pointer} pointer` : null,
    look.mic === undefined ? null : look.mic ? 'mic on' : 'mic off',
    look.systemAudio === undefined ? null : look.systemAudio ? 'system audio' : 'no system audio'
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-bg-2 p-3 text-[12.5px] text-fg">
      <p className="leading-[1.45]">{plan.summary}</p>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <span className="text-fg-muted">Angle</span>
        <span>
          {plan.source.kind === 'window' ? 'Window' : plan.source.kind === 'region' ? 'Region' : 'Screen'}
          {plan.source.target ? `: ${plan.source.target}` : ''}
          {plan.source.reason && <span className="text-fg/80"> — {plan.source.reason}</span>}
        </span>
        <span className="text-fg-muted">Length</span>
        <span>{formatTime(plan.durationSec, { fraction: false })}{plan.scenes.length ? ` + ${plan.scenes.reduce((a, s) => a + s.durationSec, 0).toFixed(1)} s of cards` : ''}</span>
        {lookBits.length > 0 && (
          <>
            <span className="text-fg-muted">Look</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {look.background && (
                <span className="inline-block h-3.5 w-7 rounded-[4px] border border-line" style={{ background: `linear-gradient(135deg, ${look.background[0]}, ${look.background[1]})` }} />
              )}
              {lookBits.join(' · ')}
            </span>
          </>
        )}
        {plan.scenes.map((s) => (
          <span key={s.id} className="contents">
            <span className="text-fg-muted">{s.kind === 'intro' ? 'Intro' : 'Outro'}</span>
            <span>
              “{s.title}”{s.subtitle ? <span className="text-fg/80"> — {s.subtitle}</span> : null} <span className="text-fg-muted">({s.style}, {s.durationSec} s)</span>
            </span>
          </span>
        ))}
      </div>
      {plan.shots.length > 0 && (
        <ol className="flex flex-col gap-0.5 border-t border-line pt-2 text-[12px]">
          {plan.shots.map((shot, i) => (
            <li key={i} className="grid grid-cols-[44px_1fr] gap-2">
              <span className="font-mono text-fg-muted">{formatTime(shot.atSec, { fraction: false })}</span>
              <span>{shot.action}</span>
            </li>
          ))}
        </ol>
      )}
      {plan.captions.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-2 text-[12px]">
          <span className="text-fg-muted">Captions, one per click · ready when the take opens</span>
          <ol className="flex flex-col gap-0.5">
            {plan.captions.map((c, i) => (
              <li key={i} className="grid grid-cols-[18px_1fr] gap-1.5">
                <span className="font-mono text-fg-muted">{i + 1}</span>
                <span>“{c}”</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {plan.prep.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-t border-line pt-2 text-[12px] text-fg/80">
          {plan.prep.map((p, i) => (
            <li key={i}>☐ {p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
