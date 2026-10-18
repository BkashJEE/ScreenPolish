// Which inspector sections each tab shows. This is the only list: the CSS that
// hides the other sections is generated from it, and inspector-tabs.test.ts
// fails when a <Section> in Knobs is on no tab. (It used to be a hand-written
// CSS selector list, and three sections shipped on none of them.)

export const INSPECTOR_TABS = [
  { id: 'scene', label: 'Scene', sections: ['Looks', 'Layout', 'Background', 'Frame', 'Mockup', 'Editor feel'] },
  { id: 'timeline', label: 'Timeline', sections: ['Title cards', 'Cuts', 'Speed regions'] },
  { id: 'motion', label: 'Motion', sections: ['Entrance', 'Cursor', 'Zoom'] },
  { id: 'layers', label: 'Layers', sections: ['Webcam', 'Layers', 'Captions'] },
  { id: 'audio', label: 'Audio', sections: ['Voiceover', 'Audio'] }
] as const

export type InspectorTab = (typeof INSPECTOR_TABS)[number]['id']

/** CSS that shows, for the active tab, only that tab's sections. */
export function inspectorTabCss(container = '.studio-inspector-groups'): string {
  const hide = `${container} > [data-section] { display: none; }`
  const show = INSPECTOR_TABS.map(
    (tab) => `${container}[data-panel="${tab.id}"] > :is(${tab.sections.map((s) => `[data-section="${s}"]`).join(', ')}) { display: block; }`
  )
  return [hide, ...show].join('\n')
}
