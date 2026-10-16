# Sequences

A sequence is one export made of several takes, one after another. It is a
layer on top of takes, not a different kind of project: ScreenPolish stays a
screen recorder with an editor for one take, and a sequence only stitches the
results. It is not a multi-track editor; for that, export the takes and use a
video editor such as Kdenlive.

## The model

```
Sequence (sequence.json, its own folder under the recordings root)
  clips: [
    { kind: 'recording', take: '2026-10-15_12-37-15', in: 0,  out: null, transition: { style: 'dissolve', durationSec: 0.5 } },
    { kind: 'recording', take: '2026-10-15_12-41-02', in: 3.2, out: 41,  transition: { style: 'none' } }
  ]
```

- **A clip is part of one take.** The take keeps everything it has today:
  trim, cuts, speed, zooms, overlays, captions and look, all on its own source
  clock, rendered by the same per-take renderer. Changing a take changes every
  sequence that uses it.
- **In and out are on the take's output clock**: the seconds its own export
  runs for, intro and outro cards included, after its trim, cuts and speed
  (`src/shared/take-time.ts`). `out: null` plays to the end, so a take that is
  trimmed later still plays whole.
- **Transitions** join a clip to the next: a hard cut, or a crossfade of 0.1
  to 2 seconds. A crossfade overlaps the two clips and never takes more than
  half of either. The transition belongs to the clip it leaves, so it moves
  with that clip when clips are reordered.
- **Sequence time** is the running total of clip lengths less the crossfade
  overlaps. The sequence needs nothing from a take but its output length.
- **Takes are named by folder**, never by path, so the recordings folder can
  move and a sequence can never point outside it.

`src/shared/sequence.ts` holds the model and its pure functions:
`normalizeSequence`, `placeClips`, `sequenceDuration`, `clipAtSequenceTime`,
`rippleAfter`, `moveClip`, `removeSequenceClip`, `setClipTransition`.

## Editing

The sequence screen is deliberately thin. Its preview is the take editor's
preview, showing whichever clip is under the playhead and switching takes at
each boundary; it cuts where the export crossfades. The clip strip orders,
removes and opens takes, and sets each clip's in and out at the playhead and
its hand-over. Everything else about a take is changed in the take editor.

## Export

Each clip is rendered by the per-take exporter into an intermediate file,
exactly as that take would export on its own, then cut to the clip's in and
out. The pieces are joined with ffmpeg: plain concatenation for hard cuts,
`xfade` and `acrossfade` for crossfades. Every take is rendered at the
sequence's output size and frame rate (the first clip's), so the pieces join
without rescaling; anything that still differs is scaled and padded to the
first part. A part without sound gets silence, so the others stay in sync.
One progress bar covers the whole run. A take used by several clips is
rendered once.

The rendering happens in the editor window, as it does for one take, so
`polish export NAME` on a sequence opens it there, like any export. It may
take a while: every take is rendered whole before it is cut.

## Later

- **B-roll**: another take or an imported video over part of a clip, full
  frame or picture in picture.
- **Title and end cards** as clips of their own (`kind: 'card'`), reusing the
  intro and outro card renderer.
- **Imported media** as clips (`kind: 'media'`), through the existing import,
  which already wraps a file as a take with an empty input log.
- More transitions than crossfade and cut.

## Credit

The clip model (start, duration, trim in and out against a source length) and
ripple behaviour follow the shape of OpenCut classic's timeline
(MIT, github.com/opencut-app/opencut-classic). No code was copied.
