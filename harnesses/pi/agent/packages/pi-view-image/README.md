# @luan.sh/pi-view-image&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-view-image)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-view-image)

`@luan.sh/pi-view-image` adds a Codex-compatible `view_image` tool to Pi. A
native Rust binary reads and validates a local PNG, JPEG, GIF, or WebP file and
returns it as a Pi image content block, so any vision-capable model can look at
a file that is already on disk. The same package makes pasted image paths in the
Pi editor attach as images and labels image attachments in the Codex format
before they reach the provider.

## Preview

![@luan.sh/pi-view-image in Bootty](https://pi.luan.sh/media/previews/pi-view-image-3b76f3119bb5.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-view-image-62df21208d2a.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-view-image
```

Requires a Rust toolchain (https://rustup.rs). The `view-image` binary builds
itself on first use under Pi's agent directory (`native/view-image/<version>/`).
Set `PI_VIEW_IMAGE_BIN` to use a prebuilt binary; it must point to an
executable file. Pi shows an info notification while the first build runs.

`view_image` uses Pi's `model-only` exposure so image content reaches the model
and transcript directly.

## The `view_image` tool

Parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `path` | string, required | Absolute path or a path relative to the Pi session's working directory. A leading `@` is stripped. `file_path` and `image_path` are accepted as aliases. |
| `detail` | `"high"` or `"original"`, optional | Defaults to `high`. |

Example call:

```json
{ "path": "screenshots/current.png", "detail": "original" }
```

Behaviour:

- `high` resizes images larger than 2000 pixels on either axis (Anthropic's
  limit for requests carrying more than 20 images). Resized
  images and GIF input are re-encoded as PNG; PNG, JPEG, and WebP files that
  are not resized keep their original bytes and MIME type.
- `original` keeps the source dimensions and bytes.
- The `detail` parameter is only exposed to models that support it. For the
  `openai-codex` provider it requires the model's `compat.supportsImageDetailOriginal`
  flag; every other provider with image input gets it. When a model does not
  support it, a requested `original` silently falls back to `high`.
- Models with image input receive the image. Text-only models receive a
  description from the configured vision model, using a separate request with
  the image and no main-session transport continuation. Disable Description
  fallback to reject text-only callers instead.
- The tool result contains one image content block. Its `details` record the
  input, the resolved path, MIME type, width, height, byte size, and duration in
  milliseconds.
- Errors from the binary (missing file, unsupported format, decode failure) are
  surfaced as the tool error message, truncated to 8192 characters.

## Pasting image paths into the editor

In the TUI, when a paste contains a single path to an existing PNG, JPEG, GIF,
or WebP file (checked by file signature, not just extension), the path is
replaced inline with an `[Image #N]` pill. Accepted forms: absolute paths,
paths relative to the working directory, `~/` paths, `file://` URLs, quoted
paths, and shell-escaped paths. This covers Pi's clipboard image paste (Pi
writes the bitmap to a temporary file and inserts its path) and terminals that
paste a file path on Command-V. Ordinary text and non-image paths are left
alone.

When the prompt is submitted, each pending pill is loaded through the native
binary at `high` detail, attached as an image, and its text becomes a
`<file name="..."></file>` tag. If a file cannot be loaded, the pill reverts to
the plain path and Pi shows a warning `Could not attach <path>: <message>`.
Pending pills are cleared on session start and shutdown.

Stash and prompt-history restoration rebuild image pills from saved file tags.
Editor exports save attachment paths rather than session-local tokens, so stashed
drafts survive a session restart. Restored images are loaded again on submit;
missing files use the same warning path as pasted images.

Submitted image tags render as numbered pills in user messages, including
resumed sessions. This is display-only: stored tags and model attachments stay
unchanged. Tags inside Markdown code remain literal.

Queued steering and follow-up images use dimmed pills too. Hover an image pill
in the fullscreen editor, transcript, or queue to preview the local file in a
floating panel without moving keyboard focus. Moving away, typing, selecting
text, or opening a dialog dismisses it. Previews use the terminal's Kitty/iTerm2
image support; terminals without graphics show image metadata. Missing files
or files over 32 MiB show an unavailable preview and do not interrupt editing.

## Codex-style image labels

Before each request is sent to the provider, user messages whose first text
block contains `<file name="...">` tags with image extensions (`bmp`, `gif`,
`jpg`, `jpeg`, `png`, `webp`) and a matching number of image blocks are
rewritten. Each image tag becomes:

```
<image name=[Image #N] path="...">
<the image block, detail high>
</image>
```

followed by the rest of the user's text. Tags are only rewritten when the count
of image tags equals the count of image blocks; otherwise the message is left
unchanged. This applies to Pi's own `@image` attachments and to pastes handled
by this package, and is provider-neutral.

Pi 0.87.1 or later owns model-specific image resizing at ingestion through
`inputLimits.images.resize`. Switching models does not re-encode images
already in the transcript. The native `view_image` tool keeps its `high` and
`original` preprocessing described above.

For older sessions, this extension repairs existing image blocks with the
stable 2000-pixel fallback. Each distinct legacy image is decoded once per
session. Repairs are saved as append-only context edits at the next turn
boundary, so resume uses the repaired bytes while raw history remains intact.
Newly ingested images are left to Pi's model profile. Repairing a legacy image
can invalidate the old prompt prefix once; it is not repeated on every request.

## Configuration

Settings use namespace `pi-view-image` in xsettings: **Describe images for text-only models**
(`descriptionFallback`) defaults to true; **Image description model**
(`descriptionModel`) defaults to `openai-codex/gpt-6-luna`. The selected model
must support image input and be authenticated in Pi. Descriptions are bounded
to 32,000 characters. The fallback applies to `view_image` calls; it does not
convert every image pasted into a text-only conversation.

`PI_VIEW_IMAGE_BIN` selects the native executable. The extension registers no
keybindings; pasting uses the editor's normal paste path.

## Layout

| Responsibility | File |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| Tool schema, aliases, model capability checks | `src/tools/view-image/definition.ts` |
| Tool result and details shape | `src/tools/view-image/result.ts` |
| Tool call and result rendering | `src/tools/view-image/presentation.ts` |
| Text-only description request | `src/runtime/describe-image.ts` |
| Native binary discovery and build | `src/native/binary.ts` |
| Running the binary and parsing its JSON | `src/native/view-image.ts` |
| Codex-style `<image>` labeling in the context hook | `src/native-attachments.ts` |
| Pasted image path detection and pending attachment tokens | `src/core/attachments.ts` |
| Turning pending tokens into attached images on submit | `src/runtime/attachments.ts` |
| Editor paste handler and pill rendering | `src/runtime/editor-attachments.ts` |
| Icon and pill appearance | `src/core/appearance.ts` |

## Develop

Source: https://github.com/luan/agents, directory
`harnesses/pi/agent/packages/pi-view-image`. Run `bun run typecheck` and
`bun test test` in that directory.
