import { useEffect, useState } from 'react'
import { BUILTIN_LOOKS } from '../../shared/builtin-looks'
import { CURSOR_SKINS, type CursorSkin } from '../../shared/ipc'
import { EMPTY_SHELF, applyLook, lookFromProject, type LookShelf } from '../../shared/presets'
import type { Project } from '../../shared/types'
import { X } from './icons'
import { Button, TextInput, cx } from './ui'

/**
 * Looks: put a ready-made look or a saved one on this recording in one click,
 * save this recording's style under a name, and star the one every new
 * recording starts with. The shelf is kept in the app's settings folder, so it
 * is shared by every recording.
 */
export function LooksPanel({ project, onProject }: { project: Project; onProject: (update: (p: Project) => Project) => void }) {
  const [shelf, setShelf] = useState<LookShelf>(EMPTY_SHELF)
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.polish.listLooks().then(setShelf).catch(() => setShelf(EMPTY_SHELF))
  }, [])

  const attempt = async (work: () => Promise<LookShelf>, done?: string) => {
    setError(null)
    try {
      setShelf(await work())
      setNote(done ?? null)
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const save = () => {
    const clean = name.trim()
    if (!clean) return
    void attempt(() => window.polish.saveLook(clean, lookFromProject(project)), `Saved “${clean}”.`).then(() => setName(''))
  }

  const makeDefault = (id: string | null) => {
    void attempt(() => window.polish.setDefaultLook(id), id ? 'New recordings start with this look.' : 'New recordings start with the app’s defaults.')
    // The live pointer while recording follows Capture's setting, so keep the two the same.
    const style = [...BUILTIN_LOOKS, ...shelf.presets].find((p) => p.id === id)?.look.cursor.style
    if (style && (CURSOR_SKINS as readonly string[]).includes(style)) void window.polish.saveSettings({ cursorSkin: style as CursorSkin }).catch(() => undefined)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] leading-[1.4] text-fg-muted">
        A look is the style: background, frame, pointer, zoom, caption and webcam style, and export shape. Cuts, words and timing stay with each recording.
      </p>
      <ul className="flex flex-col gap-1" aria-label="Ready-made looks">
        {BUILTIN_LOOKS.map((p) => {
          const isDefault = shelf.defaultId === p.id
          return (
            <li key={p.id} className="flex items-center gap-1.5">
              <button
                type="button"
                className="min-w-0 flex-1 rounded-[7px] border border-line-strong px-2.5 py-1.5 text-left hover:bg-bg-3"
                title="Put this look on this recording"
                onClick={() => {
                  onProject((cur) => applyLook(cur, p.look))
                  setNote(`Applied “${p.name}”. Undo puts the old style back.`)
                }}
              >
                <span className="block truncate text-[12px] text-fg">{p.name}</span>
                <span className="block text-[10.5px] leading-[1.35] text-fg-dim">{p.blurb}</span>
              </button>
              <StarButton name={p.name} isDefault={isDefault} onClick={() => makeDefault(isDefault ? null : p.id)} />
            </li>
          )
        })}
      </ul>
      {shelf.presets.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Saved looks">
          {shelf.presets.map((p) => {
            const isDefault = shelf.defaultId === p.id
            return (
              <li key={p.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-[7px] border border-line-strong px-2.5 py-1.5 text-left text-[12px] text-fg hover:bg-bg-3"
                  title="Put this look on this recording"
                  onClick={() => {
                    onProject((cur) => applyLook(cur, p.look))
                    setNote(`Applied “${p.name}”.`)
                  }}
                >
                  {p.name}
                </button>
                <StarButton name={p.name} isDefault={isDefault} onClick={() => makeDefault(isDefault ? null : p.id)} />
                <button type="button" aria-label={`Delete ${p.name}`} className="rounded-[6px] p-1 text-fg-dim hover:text-fg" onClick={() => void attempt(() => window.polish.deleteLook(p.id))}>
                  <X size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <TextInput
          aria-label="Look name"
          placeholder="Name this look"
          value={name}
          maxLength={40}
          spellCheck={false}
          className="min-w-0 flex-1"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') save()
          }}
        />
        <Button size="sm" disabled={!name.trim()} onClick={save}>
          Save look
        </Button>
      </div>
      {note && !error && <p className="text-[11px] text-fg-muted">{note}</p>}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  )
}

function StarButton({ name, isDefault, onClick }: { name: string; isDefault: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={isDefault}
      aria-label={isDefault ? `${name} is used for new recordings` : `Use ${name} for new recordings`}
      title={isDefault ? 'New recordings start with this look. Click to stop.' : 'Start every new recording with this look'}
      className={cx('rounded-[6px] px-1.5 py-1 text-[14px] leading-none', isDefault ? 'text-[#f5c542]' : 'text-fg-dim hover:text-fg')}
      onClick={onClick}
    >
      {isDefault ? '★' : '☆'}
    </button>
  )
}
