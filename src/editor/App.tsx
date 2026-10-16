import { readLastEdited, writeLastEdited } from './lib/last-edited'
import { useEffect, useState } from 'react'
import type { AppSettings } from '../shared/ipc'
import { DEFAULT_SHORTCUTS, shortcutLabel } from '../shared/shortcuts'
import { Editor } from './components/Editor'
import { Library } from './components/Library'
import { RecordPanel } from './components/RecordPanel'
import { RecordingBanner } from './components/RecordingBanner'
import { StudioRail, type StudioDestination } from './components/StudioRail'
import { Warning } from './components/icons'
import { EmptyState } from './components/ui'
import { useRecordingState } from './hooks/useRecordingState'
import { AppearancePicker } from './components/AppearancePicker'


type View = { kind: 'library' } | { kind: 'editor'; folder: string }
type MobilePane = 'record' | 'library'

function useCompactLayout() {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)')
    const update = () => setCompact(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return compact
}

export function App() {
  if (typeof window === 'undefined' || !window.polish) {
    return (
      <div className="h-full bg-bg-0">
        <EmptyState
          icon={<Warning size={22} />}
          title="Preload bridge missing"
          body="window.polish is not defined. This page must be opened by the Polish main process with src/preload/editor.ts attached."
        />
      </div>
    )
  }
  return <Shell />
}

function Shell() {
  const [recordShortcut, setRecordShortcut] = useState(DEFAULT_SHORTCUTS.record)
  useEffect(() => {
    const update = (settings: AppSettings) => setRecordShortcut(settings.shortcuts?.record ?? DEFAULT_SHORTCUTS.record)
    void window.polish.getSettings().then(update).catch(() => undefined)
    const listener = (event: Event) => update((event as CustomEvent<AppSettings>).detail)
    window.addEventListener('screenpolish-settings',listener)
    return () => window.removeEventListener('screenpolish-settings',listener)
  }, [])
  const [view, setView] = useState<View>(() => {
    const initialFolder = import.meta.env.DEV ? new URLSearchParams(location.search).get('open') : null
    return initialFolder ? { kind: 'editor', folder: initialFolder } : { kind: 'library' }
  })
  const [libraryKey, setLibraryKey] = useState(0)
  // The Edit tab returns to the recording that was open last, across restarts.
  const [lastEdited, setLastEdited] = useState<string | null>(() => readLastEdited())
  const [mobilePane, setMobilePane] = useState<MobilePane>('record')
  const recording = useRecordingState()
  const compact = useCompactLayout()
  const activeDestination: StudioDestination = view.kind === 'editor' ? 'editor' : mobilePane === 'record' ? 'capture' : 'library'

  const openWorkspace = (destination: 'capture' | 'library') => {
    setView({ kind: 'library' })
    setMobilePane(destination === 'capture' ? 'record' : 'library')
  }

  useEffect(() => window.polish.onOpen((folder) => setView(folder ? { kind: 'editor', folder } : { kind: 'library' })), [])

  useEffect(() => {
    if (view.kind !== 'editor') return
    setLastEdited(view.folder)
    writeLastEdited(view.folder)
  }, [view])

  // A finished recording (state back to idle) refreshes the library and the source list.
  useEffect(() => {
    if (recording.status === 'idle') setLibraryKey((k) => k + 1)
  }, [recording.status])

  return (
    <div className="polish-shell flex h-full bg-bg-0 text-fg">
      <StudioRail
        active={activeDestination}
        editorAvailable={view.kind === 'editor' || lastEdited !== null}
        onCapture={() => openWorkspace('capture')}
        onLibrary={() => openWorkspace('library')}
        onEditor={() => {
          if (view.kind === 'editor') return
          if (lastEdited) setView({ kind: 'editor', folder: lastEdited })
        }}
      />
      <div className="studio-main flex min-h-0 min-w-0 flex-1 flex-col">
        <RecordingBanner state={recording} />
        {view.kind === 'library' ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="studio-topbar drag">
              <div className="studio-heading">
                <span className="studio-heading-kicker">{mobilePane === 'record' ? 'Capture workspace' : 'Recording library'}</span>
                <strong>ScreenPolish</strong>
              </div>
              <div className="studio-topbar-spacer" />
              <AppearancePicker />
              <div className="studio-status no-drag" data-state={recording.status}>
                <span />
                {recording.status === 'idle' ? 'Ready' : recording.status}
              </div>
              <div className="studio-shortcut no-drag">
                <kbd>{shortcutLabel(recordShortcut)}</kbd>
              </div>
            </header>
            {compact && (
              <nav className="mobile-pane-switcher" aria-label="ScreenPolish workspace">
                <button type="button" className={mobilePane === 'record' ? 'is-active' : ''} onClick={() => setMobilePane('record')}>
                  Record
                </button>
                <button type="button" className={mobilePane === 'library' ? 'is-active' : ''} onClick={() => setMobilePane('library')}>
                  Library
                </button>
              </nav>
            )}
            <div className="flex min-h-0 min-w-0 flex-1">
              {/* Keep capture inputs mounted so switching to Library does not
                  discard the chosen source or microphone. Only one pane is visible. */}
              <div className="capture-workspace min-h-0 min-w-0 flex-1" style={{ display: mobilePane === 'record' ? 'flex' : 'none' }}>
                <RecordPanel recording={recording} refreshKey={libraryKey} />
              </div>
              {mobilePane === 'library' && (
                <Library refreshKey={libraryKey} onOpen={(folder) => setView({ kind: 'editor', folder })} />
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1">
            <Editor folder={view.folder} onBack={() => openWorkspace('library')} onOpen={(folder) => setView({ kind: 'editor', folder })} />
          </div>
        )}
      </div>
    </div>
  )
}
