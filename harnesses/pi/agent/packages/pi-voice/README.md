# @luan.sh/pi-voice

Realtime conversation, editable dictation, and a phone interface for the current
Pi session. Uses Codex credentials from Pi's normal auth store. The main Pi model
can be any provider; the voice service and default context summarizer require
an authenticated Codex account with access to those services.

## Use it

Press **Alt+V** in the managed harness to open Voice. The menu contains Start voice, Dictate a draft, and Connect phone.
Nothing records or listens on the network until you choose a control.

- **Start voice** starts a spoken conversation with context from the current Pi session.
  Spoken requests go to the same Pi agent; progress and results return to the call.
  Reopen Voice to **Mute** or **Stop**.
- **Dictate a draft** records a draft. **Finish dictation** adds the transcription to the editor,
  where you can edit it before sending. **Cancel** discards the recording.
  The footer shows connecting, recording, and transcribing; an empty recording
  reports an error.
- **Connect phone** opens a private link for a browser on the same network. Open the link,
  accept this computer's local certificate, and allow microphone access when
  starting voice or dictation. The page also has an editable text field and Pi's
  responses. The microphone meter shows captured audio; recording and
  transcription have separate visible states. **Stop phone access** closes the listener and invalidates the link.

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

## Settings and actions

Settings appear under **Voice** in xsettings' Behavior category. The namespace
is `pi-voice`; defaults apply when xsettings is absent.

| Setting | Default |
| --- | --- |
| Voice (`v3Voice`) | `cove` |
| Microphone / speaker (`inputDevice`, `outputDevice`) | System default; optional device IDs |
| Spoken acknowledgements | On |
| Reconnect voice (`autoResume`) | Off |
| Refresh voice context (`refreshAfterCompaction`) | On |
| Context model (`contextModel`) | `openai-codex/gpt-5.6-luna` |

Actions `voice.start`, `voice.dictate`, `voice.mute`, `voice.stop`, and
`voice.phone` can be bound through the normal actions/keybindings system.
The extension assigns no default shortcuts. The managed `keybindings.json` binds
`voice.open` to Alt+V. Active voice shows a compact status; reopen the menu
to mute, stop, or finish dictation.

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
| TUI controls | `src/ui.ts`; shared `SelectBox` |
| Phone HTTPS, ownership, browser audio | `src/lan/` |
| Settings | `src/settings.ts`; public xsettings SDK |
| Native microphone, speaker, Opus, WebRTC | `crates/voice-host`; bounded stdio protocol |
| Public tool definitions | None; voice uses Pi's existing user-input path |

The realtime protocol, dictation, native audio, and certificate support are
adapted from [howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff),
revision `a88a72bc68d133b6648da133ea9056cda70cf0c5`. MIT notices are retained in
this package and `crates/voice-host/HOWABOUA-LICENSE`.
