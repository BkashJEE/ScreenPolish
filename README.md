# ScreenPolish

A screen recorder that polishes the take for you. It zooms toward every click,
smooths the pointer path, and frames the result on a background. Pick the
**Studio** look and a first take comes out finished: a bright background, a
golden Star pointer, gliding zooms with motion blur and word-by-word captions.
No account, no upload, no telemetry — the recording never leaves your machine.

On Omarchy and other Hyprland desktops it records without the system cursor at
all, and draws its own instead.

[![Latest release](https://img.shields.io/github/v/release/BkashJEE/ScreenPolish?label=release)](https://github.com/BkashJEE/ScreenPolish/releases/latest)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

**Linux, one command** (Windows and macOS installers are on the
[releases page](https://github.com/BkashJEE/ScreenPolish/releases/latest)):

```bash
curl -fsSL https://github.com/BkashJEE/ScreenPolish/releases/latest/download/ScreenPolish-installer.run -o screenpolish.run && chmod +x screenpolish.run && ./screenpolish.run
```

**On Omarchy**, add the bar widget to start, stop and watch a recording without
leaving the window you are recording:

```bash
omarchy plugin add https://github.com/BkashJEE/screenpolish-omarchy-plugin --enable
```

<p>
  <img src="docs/images/features/screenpolish.svg" width="49%" alt="ScreenPolish: Record. Polish. Export. Local, private and free, for Omarchy / Hyprland and Windows.">
  <img src="docs/images/features/auto-zoom.svg" width="49%" alt="Automatic zoom: zooms toward every click and glides back out, from the clicks recorded with the take.">
</p>

<p>
  <img src="docs/images/features/cursor-free-capture.svg" width="49%" alt="Cursor-free capture: records Hyprland natively without the system cursor, then draws a clean one on top.">
  <img src="docs/images/features/edit.svg" width="49%" alt="Cut and transition: split at the playhead, remove what you don't need and smooth over every cut.">
</p>

<p>
  <img src="docs/images/features/captions.svg" width="49%" alt="Offline captions: transcribed on your machine with whisper.cpp and burned into the export. Nothing uploaded.">
  <img src="docs/images/features/export.svg" width="49%" alt="Export anywhere: MP4 or GIF up to 2160p at 60 fps, in 16:9, 9:16, 1:1 or the source shape.">
</p>

**[Every feature →](docs/FEATURES.md)**

## What it does

- **Records** a screen, a window or a region. On Hyprland that goes through
  `gpu-screen-recorder`: no share dialog, and the system cursor stays out of
  the video entirely.
- **Dresses the take in one click.** Ready-made looks — **Studio**, **Shorts**
  (9:16, bold captions) and **Clean** — or save your own and star the one every
  new recording starts with.
- **Zooms on clicks**, built from the pointer path and button events recorded
  with the take, and glides back out, with optional motion blur on every pan
  and zoom.
- **Draws the pointer**: a golden **Star** with a trail, a **Halo** ring, or
  arrow, hand, dot and bobbing, with click ripples, optional click sounds, and
  a fade while the pointer rests. **Click timing** lines clicks up with the
  picture if they land late.
- **Edits without an editor**: trim, split, drop clips, smooth over the cuts,
  remove silences and filler words ("um", "uh"), change speed, crop.
- **Captions offline**, with a bundled whisper.cpp — nothing uploaded. Four
  styles, including word-by-word Karaoke and big Bold, and `.srt` export.
- **Cleans up your voice**: takes down hiss, hum and keyboard noise in the
  microphone and evens out the level, on your machine. The original is kept.
- **Edits videos made elsewhere**: open an OBS, phone or other recording and
  give it the same frame, background, captions and export.
- **Annotates**: blur or pixelate, arrows, highlight boxes, text and images.
- **Exports** MP4 or GIF up to 2160p at 60 fps, in 16:9, 9:16, 1:1, 4:5, 4:3
  or the source shape. GIFs choose their frame rate, width and whether they
  loop.
- **Adds intro and outro cards**: a title, a line under it and up to six
  steps that arrive one by one, calm or bold, over the take's own background.
- **Keeps the last 30 seconds** (Linux): a replay buffer holds the screen in
  memory and a shortcut saves it, for the moment you did not know was coming.
- **Answers a command line** (`record`, `clip`, `export`, `replay`), which
  makes it scriptable.

## Works with your AI agent

**Plan before you record.** Tell the agent you already use what the video is
for — *"a 30-second demo of exporting a GIF, for X"* — and it drafts the angle
to record and why, the length, a shot list, the look and the intro and outro
cards. Ask for changes, then **Apply** and it is all set up; press Record.
Claude Code and Codex are found by themselves, any other command-line agent is
one line in `plan-agents.json`. The agent runs with its tools off;
ScreenPolish itself still sends nothing anywhere.

**Let the agent film its own work.** An MCP server lets Claude Code or any MCP
client start a recording, do the thing, stop, and get a polished MP4 back — or
hold a replay buffer and save it when something interesting happens:

```bash
claude mcp add screenpolish -- node /path/to/screenpolish/mcp/dist/index.js
```

Setup for other clients is in [`mcp/README.md`](mcp/README.md).

## What differs by platform

| | Linux (Hyprland) | Windows | macOS |
| --- | --- | --- | --- |
| Capture without the system cursor | yes, native | no | no |
| Drawn pointer replaces the real one | yes | overlay | captured cursor stays |
| Click and pointer log | evdev, mouse only | uiohook | uiohook |
| Offline captions | bundled | bundled, untested | bundled, untested |
| Updates | rerun the installer | itself, from published releases | download the new build |
| Everything else | yes | yes | yes |

Where the system cursor is captured, the drawn pointer styles have nothing to
replace, so zoom, framing, editing and export still work but the cursor in the
video is the real one.

## Install

Builds for each platform are on the
[releases page](https://github.com/BkashJEE/ScreenPolish/releases).

**Linux.** One file that checks your system, asks where the app should live,
and offers to install what is missing:

```bash
curl -fsSL https://github.com/BkashJEE/ScreenPolish/releases/latest/download/ScreenPolish-installer.run -o screenpolish.run
chmod +x screenpolish.run
./screenpolish.run
```

Or take the `.pacman` for Arch and Omarchy, or the `.AppImage` for anything
else. `./screenpolish.run --uninstall` removes exactly what it installed and
leaves your recordings alone.

**Windows.** Run the installer and pick where it goes. It is not code signed,
so SmartScreen will warn you: *More info* → *Run anyway*. After that it updates
itself: each published release downloads in the background and installs when
you choose *Restart to update*, or the next time you close the app. It never
restarts while you are recording or exporting.

**macOS.** Unsigned as well, so macOS quarantines it:

```bash
xattr -dr com.apple.quarantine /Applications/ScreenPolish.app
```

## Requirements

- **Linux**: a Wayland session. `gpu-screen-recorder` for cursor-free native
  capture; without it, capture falls back to the desktop portal, where the
  system cursor is baked into the video. Membership of the `input` group so
  clicks can be recorded: `sudo usermod -aG input $USER`, then log out and
  back in. Without it there are no clicks, and automatic zoom has nothing to
  work from — the app says so at the start of a take.
- **Windows**: Windows 10 or 11.
- **macOS**: screen recording permission, granted on first use.
- **Building**: Node 22 or 24. Node 26 breaks Electron's own installer.

## Build and run

```bash
npm ci
npm run fetch:whisper     # captions engine and model, into vendor/whisper (Git Bash on Windows)
npm run dev               # run it
npx electron-builder --linux pacman AppImage --publish never
npx electron-builder --win nsis --publish never
npx electron-builder --mac dmg zip --publish never
```

Each platform's installer must be built on that platform, except that macOS
app bundles can be produced elsewhere — unsigned, which macOS will notice.

## Privacy

- Recordings, input logs and projects live in your recordings folder, by
  default `~/Videos/ScreenPolish`. Nothing else is written.
- On Linux keyboards are never opened: the pointer path comes from the
  compositor and button presses from a single evdev device.
- The app sends nothing anywhere. The one network request is the Windows
  update check, which asks GitHub for the latest published release; set
  `POLISH_NO_UPDATES=1` to turn it off. Linux and macOS builds make none.

## Licence

MIT; see `LICENSE`. In short: use it, change it, ship it in whatever you like,
commercial or not — just keep the copyright notice.

The installers bundle **ffmpeg**, which is GPL-3.0 and stays that way. That
covers the bundled binary, not this project's code. Its licence and where to
get its source are in `THIRD_PARTY_NOTICES.md`.

The name "ScreenPolish" and the logo are not covered by that licence.

Independent project: not affiliated with, endorsed by or sponsored by Omarchy,
Hyprland or any other project it works alongside. Bundled third-party
components are listed in `THIRD_PARTY_NOTICES.md`.
