# @luan.sh/pi-voice

Realtime conversation, editable dictation, and a phone interface for the current
Pi session. Uses Codex credentials from Pi's normal auth store. The main Pi model
can be any provider; the voice service and default context summarizer require
an authenticated Codex account with access to those services.

## Use it

The managed harness binds these actions:

- **Alt+V** starts a spoken conversation with context from the current Pi session.
  Press it again to stop, including while connecting. Spoken requests go to the
  same Pi agent; progress and results return to the call.
- **Ctrl+X** mutes or unmutes an active voice call. With voice off, Pi's normal
  copy-message shortcut still works.
- **Alt+Shift+V** starts dictation. Press it again to finish and add the transcription
  to the editor, where you can edit it before sending. **Escape** cancels without
  changing the draft, including while connecting or transcribing. Pressing the
  dictation binding again before recording starts cancels startup.
  The strip above the editor shows connecting, recording, and transcribing; an empty recording
  reports an error. Finish or cancel one mode before starting the other.
- **`/voice:connect`** opens a private link for a browser on the same network.
  Open the link, accept this computer's local certificate, and allow microphone
  access when starting voice or dictation. The page also has an editable text
  field and Pi's responses. The microphone meter shows captured audio; recording
  and transcription have separate visible states. **Stop phone access** closes
  the listener and invalidates the link.

The voice strip stays above the editor, leaving the normal status line and your
draft available. A filled microphone dot means capture is active; a hollow dot
means connecting, muted, or finishing. Microphone and Pi audio meters show six
recent measured peaks, sampled every 100 ms. Live captions stay in the strip
until completed turns enter the conversation. Narrow terminals wrap controls
and hide meters that do not fit. Older native helpers without level events
omit the meters.

Nothing records or listens on the network until you start it.

A phone link grants access to this Pi session. Only one browser owns the
microphone at a time; starting from another browser transfers ownership. A
browser disconnect mutes the call. Reconnecting does not silently reacquire the
microphone. Codex credentials stay on this computer.

## Context and reconnects

Voice gets a generated, readable summary of the Pi conversation at startup.
It refreshes after compaction, context rollover, and branch navigation. Notes,
voice transcript entries, and available Pi compaction summaries contribute to
continuity; encrypted Codex checkpoints are not sent to the voice model.
Spoken user and assistant turns appear as readable conversation entries. Only
requests delegated by the voice model start Pi work.
Speech received during refresh remains in the transcript and pending requests
are delivered after the transition.

Enable **Reconnect voice** to replace an established call after a transport
drop. Startup failures do not retry automatically. Reconnection and context
refresh preserve the mute state. Session switching closes the current call.

Personal instructions may be placed in
`<Pi agent directory>/REALTIME-SYSTEM-PROMPT.md` or the project's
`.pi/REALTIME-SYSTEM-PROMPT.md`. Each is limited to 8 KiB. The extension reads
these files and does not create or overwrite them.

Native microphone audio uses Codex-derived echo cancellation, noise suppression,
and gain control. The echo reference comes from actual device playback with
capture/playback timestamps. Mute transitions discard earlier captured audio;
microphone failure stops forwarding and reports an error. Browser audio continues
to use the browser's own echo cancellation.

## Settings and actions

Settings appear under **Voice** in xsettings' Behavior category. The namespace
is `pi-voice`; defaults apply when xsettings is absent.

| Setting | Default |
| --- | --- |
| Voice (`v3Voice`) | `sol` |
| Microphone / speaker (`inputDevice`, `outputDevice`) | System default; optional device IDs |
| Spoken acknowledgements | On |
| Reconnect voice (`autoResume`) | Off |
| Refresh voice context (`refreshAfterCompaction`) | On |
| Context model (`contextModel`) | `openai-codex/gpt-6-luna` |

Actions `voice.toggle`, `voice.start`, `voice.dictate`, `voice.mute`, and
`voice.stop` can be bound through the normal actions/keybindings system.
The extension assigns no default shortcuts. The managed `keybindings.json` owns
Alt+V, Alt+Shift+V, and Ctrl+X; active voice shows the configured keys above the editor.
`/voice` toggles conversation. `/voice start`, `/voice dictate`, `/voice mute`, and
`/voice stop` provide the same controls without keybindings. Phone access has its
own command, `/voice:connect`.

## Standalone installation

Install `harnesses/pi/agent/packages/pi-voice` with Pi's package manager from a
checkout. The extension does not require `pi-codex-conversion`. A Rust toolchain
builds `voice-host` on first use; `PI_VOICE_HOST_BINARY` may select a prebuilt
binary. macOS may request microphone access for the terminal running Pi.

The phone interface uses local HTTPS with a generated certificate, an expiring
per-server access token, origin validation, and bounded WebSocket traffic. It
supports eight connected browsers. It provides the phone/LAN functions of
upstream GipPity through our extension's controls and page.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Pi lifecycle, prompt contribution, compaction events | `src/extension.ts` |
| Call ownership, delegation, refresh and reconnect | `src/controller.ts` |
| Realtime wire protocol and spoken handoffs | `src/conversation/`, `src/turns.ts` |
| Editable transcription | `src/dictation/` |
| TUI controls | `src/ui.ts`, `src/voice-strip.ts`; actions, live strip, and contextual Escape |
| Phone HTTPS, ownership, browser audio | `src/lan/` |
| Settings | `src/settings.ts`; public xsettings SDK |
| Native microphone, speaker, Opus, WebRTC | `crates/voice-host`; bounded stdio protocol |
| Public tool definitions | None; voice uses Pi's existing user-input path |

The realtime protocol, dictation, native audio, and certificate support are
adapted from [howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff),
revision `a88a72bc68d133b6648da133ea9056cda70cf0c5`. MIT notices are retained in
this package and `crates/voice-host/HOWABOUA-LICENSE`.
