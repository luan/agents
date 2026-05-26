# Visual Doc Reference

## Plannotator HTML base

```html
<style>
:root {
  --background: oklch(0.97 0.005 260);
  --foreground: oklch(0.18 0.02 260);
  --card: oklch(1 0 0);
  --muted: oklch(0.92 0.01 260);
  --muted-foreground: oklch(0.40 0.02 260);
  --primary: oklch(0.50 0.25 280);
  --secondary: oklch(0.50 0.18 180);
  --accent: oklch(0.60 0.22 50);
  --success: oklch(0.45 0.20 150);
  --warning: oklch(0.55 0.18 85);
  --destructive: oklch(0.50 0.25 25);
  --border: oklch(0.88 0.01 260);
  --radius: 0.625rem;
  --font-sans: Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --font-display: ui-serif, Georgia, serif;
}
body { margin: 0; background: var(--background); color: var(--foreground); font: 16px/1.65 var(--font-sans); }
.container { max-width: 1080px; margin: 0 auto; padding: 64px 24px; }
.eyebrow, .badge { font: 700 12px/1 var(--font-mono); text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground); }
h1, h2, h3 { font-family: var(--font-display); font-weight: 500; line-height: 1.15; }
.card { background: var(--card); border: 1.5px solid var(--border); border-radius: var(--radius); padding: 24px; }
.summary-strip, .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
.callout { border-left: 4px solid var(--primary); background: var(--muted); padding: 16px 18px; border-radius: var(--radius); }
code, pre { font-family: var(--font-mono); }
img, video { max-width: 100%; border: 1px solid var(--border); border-radius: var(--radius); }
</style>
```

## Evidence media

Use Plannotator's local image proxy for screenshots and rendered GIFs:

```html
<img src="./api/image?path=%2Ftmp%2Fexample.png" alt="Specific observed state">
```

Generate the encoded path with `encodeURIComponent(absolutePath)`. Place the
absolute path beside the media for direct inspection.

For TUI work, prefer the asciinema web player when interactive replay is useful
and Plannotator's rendered HTML can run the player script:

```bash
asciinema record --headless --overwrite --window-size 80x24 \
  --idle-time-limit 1 --command '<deterministic command>' /tmp/tui.cast
npm install --save-dev asciinema-player
```

Copy `dist/bundle/asciinema-player.min.js` and
`dist/bundle/asciinema-player.css` from the package into the artifact folder,
then initialize with embedded cast data:

```html
<link rel="stylesheet" href="./asciinema-player.css">
<div id="tui-player"></div>
<script src="./asciinema-player.min.js"></script>
<script>
  AsciinemaPlayer.create({ data: ASCIICAST_TEXT }, document.getElementById("tui-player"), {
    preload: true,
    terminalFontSize: "14px"
  });
</script>
```

Keep the `.cast` path visible as the replay/audit artifact. When script-based
rendering is unavailable or the review needs a static glanceable artifact, render
a GIF with `agg` and embed it through the local image proxy:

```bash
agg --theme github-dark --speed 2 --idle-time-limit 1 /tmp/tui.cast /tmp/tui.gif
```
