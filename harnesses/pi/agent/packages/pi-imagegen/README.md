# @luan.sh/pi-imagegen

Codex image generation and editing using the standalone
`@howaboua/pi-codex-imagegen` package, pinned to `0.0.4`. The conversion extension is not required.
Sign in to OpenAI Codex in Pi, then ask for an image. The managed harness loads
the tool automatically.

`image_gen__imagegen` accepts `prompt` plus either `referenced_image_paths` or
`num_last_images_to_include` for edits. Omit both selectors for a new image.
Generated files are saved by the upstream package and their paths appear in the
result. In Code Mode, use `generatedImage(await tools.image_gen__imagegen(...))`.

Install independently with `pi install ./harnesses/pi/agent/packages/pi-imagegen`.
Do not also load the upstream extension entry point: this package registers its
public tool implementation with our shared renderer and Code Mode adapter.

| Responsibility | Owner |
| --- | --- |
| Generation, editing, credentials, artifacts | Public upstream imagegen package |
| Tool definition and presentation | `src/tools/imagegen/definition.ts`; shared ToolActivity |
| Registration and Code Mode | `src/extension.ts` |
| Public library | `src/index.ts` |
| Native boundary | None |
