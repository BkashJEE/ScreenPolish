import type { LoadedProject } from '../../shared/ipc'
import type { Project } from '../../shared/types'

/** The media to play and export: the cleaned-up microphone in place of the original while Clean up voice is on. */
export function withCleanVoice(project: Project, urls: LoadedProject['urls'], cleanUrl: string | undefined = urls.micClean): LoadedProject['urls'] {
  return project.audio.micClean && cleanUrl && urls.mic ? { ...urls, mic: cleanUrl } : urls
}
