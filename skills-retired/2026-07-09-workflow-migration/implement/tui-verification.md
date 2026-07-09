# TUI Verification

Use this reference for terminal UI behavior before creating the manual-verification gate.

## Recording interactive usage

Record the actual TUI interaction with `asciinema` through a PTY forwarder. The driver sets up fixtures, launches the real TUI on a child PTY, streams child PTY output to stdout, and sends paced input to the child PTY. The rendered player should show the starting state, interaction path, and resulting state without harness chatter or terminal negotiation dominating the replay.

Embed the recording with the asciinema player in the `$visual-doc` report. Use `agg` GIFs only as secondary static evidence or when the player is genuinely unavailable.

## Asciinema player report pattern

1. Write a small self-contained PTY driver. A known-good shape is:
   - create a child PTY with Python `pty.openpty()`;
   - spawn the real TUI with stdin/stdout/stderr attached to the child PTY;
   - continuously `select`/`read` from the child PTY and write bytes to stdout;
   - write scheduled keystrokes to the child PTY with human-visible delays.

2. Record the driven TUI scenario:

   ```bash
   asciinema record --headless --overwrite --window-size 80x24 \
     --command '<self-contained PTY driver that streams output and sends paced input>' /tmp/tui.cast
   ```

   Use this PTY-forwarder shape instead of raw `expect`; raw `expect` often buffers output until the end of the run.

3. Inline the vendored player assets in the temporary HTML artifact:

   ```html
   <style>
     /* contents of <implement-skill-dir>/vendor/asciinema-player/asciinema-player.css */
   </style>
   <script>
     /* contents of <implement-skill-dir>/vendor/asciinema-player/asciinema-player.min.js */
   </script>
   ```

4. Embed the recording in the report with the player:

   ```html
   <style>
     /* contents of <implement-skill-dir>/vendor/asciinema-player/asciinema-player.css */
   </style>
   <div id="tui-player"></div>
   <script>
     /* contents of <implement-skill-dir>/vendor/asciinema-player/asciinema-player.min.js */
   </script>
   <script>
     const castText = /* JSON.stringify(contents of /tmp/tui.cast) */;
     AsciinemaPlayer.create(
       { data: castText },
       document.getElementById("tui-player"),
       {
         preload: true,
         autoPlay: true,
         terminalFontSize: "14px",
         fit: false
       },
     );
   </script>
   ```

   Use `{ data: castText }`, not a relative `.cast` URL, for Plannotator gates.
   Inline the player CSS/JS in the artifact so the rendered gate is self-contained.
   Keep the player container fixed-height or otherwise strictly bounded; avoid
   `100vh`, `min-height: 100vh`, and unbounded media sections because Plannotator
   can render them as extremely tall pages.

   `poster` values use the `npt:` prefix (for example, `poster: "npt:3.58"`).
   `startAt` values are numeric/NPT strings without the prefix (for example,
   `startAt: "2.20"`). When a visual state is transient, add a marker at the
   target time and set `pauseOnMarkers: true` so the playback stops on the state
   under review instead of running through teardown.

   Browser DOM probes of asciinema-player may not expose terminal cell background
   colors as span `background-color`; validate background-sensitive TUI states by
   viewing the rendered player frame and by checking the cast for the relevant
   SGR output.

5. View the rendered report before presenting the gate. The player is ready only
   when it visibly demonstrates the scenario; a generated cast file by itself is
   not enough.

## Evidence to capture

- Startup screen.
- Changed interaction path with keystrokes used.
- Empty, loading, success, and failure states when relevant.
- Snapshot files, screenshots, recordings, or terminal transcripts.
- Embed the asciinema player as the primary TUI evidence; include any GIF as supplemental fallback evidence.
- Exact command, environment variables, terminal size, and test data.

Use `$visual-doc` for the shared asciinema player, `agg` fallback, local image proxy, and Plannotator report layout.

## Boundaries

- Keep automated tests as the primary regression signal.
- Run recordings in asciinema's PTY instead of attaching to tmux, screen, or the user's live terminal session.
- Use TUI evidence as manual-verification support; acceptance still requires the Plannotator manual-verification gate.
