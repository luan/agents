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
   <div id="tui-player"></div>
   <script>
     const castText = /* JSON.stringify(contents of /tmp/tui.cast) */;
     AsciinemaPlayer.create(
       { data: castText },
       document.getElementById("tui-player"),
       { preload: true, terminalFontSize: "14px" },
     );
   </script>
   ```

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
