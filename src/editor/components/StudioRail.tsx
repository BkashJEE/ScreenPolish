import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/ipc'
import { Film, Record, Screen } from './icons'
import { cx } from './ui'

export type StudioDestination = 'capture' | 'library' | 'editor'

export function StudioRail({
  active,
  editorAvailable,
  onCapture,
  onLibrary,
  onEditor
}: {
  active: StudioDestination
  editorAvailable: boolean
  onCapture: () => void
  onLibrary: () => void
  onEditor: () => void
}) {
  const item = (destination: StudioDestination, label: string, icon: React.ReactNode, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className={cx('studio-rail-item no-drag', active === destination && 'is-active')}
      onClick={onClick}
      disabled={disabled}
      aria-current={active === destination ? 'page' : undefined}
      title={disabled ? `${label} opens once you have opened a recording from the library` : label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <aside className="studio-rail" aria-label="ScreenPolish workspace">
      <div className="studio-mark drag" aria-label="ScreenPolish">
        {/* The real mark, served from resources by the polish:// asset route. */}
        <img src="polish://asset/icon-256.png" alt="" width={30} height={30} draggable={false} />
      </div>
      <nav>
        {item('capture', 'Capture', <Record size={17} />, onCapture)}
        {item('library', 'Library', <Film size={17} />, onLibrary)}
        {item('editor', 'Edit', <Screen size={17} />, onEditor, !editorAvailable)}
      </nav>
      <UpdateNotice />
      <div className="studio-local-state" title="All recording and rendering stays on this computer">
        <span className="studio-local-dot" />
        Local
      </div>
    </aside>
  )
}

/**
 * A downloaded update, offered quietly at the foot of the rail. Nothing shows
 * unless there is one: Linux and macOS builds never have one, and on Windows
 * it appears only once a published release has finished downloading.
 */
function UpdateNotice() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.polish.updateState().then(setState).catch(() => undefined)
    return window.polish.onUpdateChanged(setState)
  }, [])
  if (state.status === 'idle') return null
  if (state.status === 'downloading') {
    return (
      <div className="no-drag px-1 text-center text-[10px] leading-tight text-fg-dim" title={`Downloading ScreenPolish ${state.version}`}>
        Update {state.percent}%
      </div>
    )
  }
  return (
    <button
      type="button"
      className="no-drag mx-1 rounded-[7px] bg-accent px-1 py-1.5 text-[10.5px] font-semibold leading-tight text-[#1a0f09] hover:brightness-110"
      title={error ?? `ScreenPolish ${state.version} is ready. Restart to update; otherwise it installs when you close the app.`}
      onClick={() => {
        setError(null)
        window.polish.installUpdate().catch((e: unknown) => {
          const message = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          setError(message)
          window.alert(message)
        })
      }}
    >
      Restart to update
    </button>
  )
}
