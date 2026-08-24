# pi-view-image

`pi-view-image` adds a Codex-compatible `view_image` tool. A Rust bridge reads
and validates a local PNG, JPEG, GIF, or WebP file and returns a native Pi image
content block. GIF input is normalized to a PNG frame; the other supported
formats retain their original bytes.

## Install

Build the native bridge, then install the package from the repository root:

```sh
cargo build --release -p view-image
pi install ./harnesses/pi/agent/packages/pi-view-image
```

The bridge resolver checks `PI_VIEW_IMAGE_BIN`, then the workspace release and
debug targets. The override must point to an executable file.

## Usage

Pass a path relative to the Pi session directory or an absolute path:

```json
{ "path": "screenshots/current.png" }
```

An optional leading `@` is removed. `file_path` and `image_path` are accepted as
argument aliases before schema validation. `detail` defaults to `high`, which
resizes images larger than 2048 pixels on either axis. Use `original` to retain
the source dimensions and bytes.

The package registers the tool directly and through `pi-code-mode/sdk`. Inside
Code Mode, the shared adapter reuses the same tool execution and presentation,
then returns `{ image_url, detail }`; forward that value with `image(result)`.

Pi's native `@image` path initially creates a `<file>` wrapper followed by an
image block. Before provider serialization, this package rewrites that content
to Codex's labeled sequence: `<image name=[Image #N] path="...">`, the image at
high detail, `</image>`, then the user's text. The context hook is
provider-neutral, so the same message reaches every vision-capable provider.

Native clipboard image paste and terminal-native path paste share the same
attachment path. Pi saves clipboard bitmap data to a temporary image file; the
package recognizes that inserted path, replaces it inline with `[Image #N]`,
rendered from a private atomic editor token, and carries the image into the
submitted input. Bracketed pastes from macOS
Command-V are handled the same way when the terminal supplies an image path.
Ordinary paths and non-image pastes keep Pi's normal editor behavior.

The capability check is provider-neutral: any Pi model that advertises `image`
input is supported, including Anthropic vision models. Models without that
declared capability fail before the file is read.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| Native attachment labeling | `src/native-attachments.ts` |
| Clipboard/path attachment state | `src/core/attachments.ts` and `src/runtime/attachments.ts` |
| Atomic editor paste and rendering | `src/runtime/editor-attachments.ts` via `pi-libtui/editor` |
| Tool schema and model support check | `src/tools/view-image/definition.ts` |
| Execution owner | `src/native/view-image.ts` and `crates/view-image` |
| Native binary discovery | `src/native/binary.ts` |
| Result/details model | `src/tools/view-image/result.ts` |
| Presentation owner | Pi default `ToolExecutionComponent` |
| Code Mode adapter | `src/code-mode-adapter.ts` via `pi-code-mode/sdk` |

Image loading and direct tool execution do not depend on another feature
extension. The package uses the UI-free `pi-code-mode/sdk` entry point to make
the same tool available inside Code Mode; the package dependency installs that
public registration surface with it.

## Validation

```sh
cargo nextest run -p view-image
bun run --cwd=harnesses/pi/agent/packages/pi-view-image typecheck
bun test --cwd=harnesses/pi/agent/packages/pi-view-image
just pi-install-check harnesses/pi/agent/packages/pi-view-image
```
