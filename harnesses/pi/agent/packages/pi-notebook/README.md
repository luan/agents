# @luan.sh/pi-notebook

Persistent JavaScript and TypeScript execution in Deno. Bindings survive between
cells, so the agent can load data once and explore it over several requests.
The managed harness loads this package automatically. Ask Pi:

> In the notebook, save an array of three numbers. In a second cell, calculate
> their sum. Restart the notebook and confirm the array survived.

No setup commands are needed in the managed harness. The runtime starts on the
first notebook call. Deno 2.9.5 downloads once into Pi's cache; the download and
executable are checked against pinned SHA-256 hashes.

## Tools

| Tool | Use |
| --- | --- |
| `notebook__exec({code})` | Run a JS/TS cell with top-level await, imports, filesystem and network access. |
| `notebook__control({action})` | `status`, `checkpoint`, `restart`, or `reset`. |
| `notebook__control({action, name})` | `save_profile` or `load_profile`, with a name containing letters, numbers, underscores, or hyphens. |

Code Mode can call the same tools. Its result contains `text` and an `images`
array of data URLs; use `text(result.text)` and `image(url)` for each image.
The existing `exec` tool still starts a fresh restricted V8 isolate. Notebook
code runs in a separate Deno process with access to the host environment.

Only one notebook operation runs at a time. Cancelling a cell shuts down its
kernel; the next call restores the last completed checkpoint. Closing Pi also
closes the kernel. Notebook identity follows the Pi session and working
directory; navigation within a session does not rewind its running notebook.

## Checkpoints and profiles

After each cell, the host checkpoints serializable bindings by value. Restart
restores those values without replaying code or repeating file/network side
effects. Functions, promises, and native handles cannot be restored and are
reported as skipped. A checkpoint is not a snapshot of the operating system,
module loader, or external resources. A failed cell may have changed bindings
before it failed; those resulting values are checkpointed too.

Session checkpoints live under `<Pi agent directory>/cache/pi-notebook/sessions/`.
Profiles live under `cache/pi-notebook/profiles/`, scoped to the working directory.
Reset clears current bindings and the session checkpoint, while profiles remain.
Loading a profile replaces the current bindings after validating its values in
a fresh kernel. Output is bounded to 8 MiB and checkpoints to 16 MiB.

## Standalone installation

From a checkout, install `harnesses/pi/agent/packages/pi-notebook` with Pi's
package manager. Enable its two tools in Pi's tool selection. A Rust toolchain
is needed to build `notebook-host` on first use; `PI_NOTEBOOK_HOST_BINARY` may
point to a prebuilt executable. Each package installs independently of the
Codex provider and voice extension.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool schemas, execution adapter, result details | `src/tools/definition.ts` |
| Tool presentation | Shared `ToolActivity`, text and image previews |
| Pi lifecycle and Code Mode registration | `src/extension.ts` |
| Process ownership and framed protocol | `src/runtime/client.ts` |
| Deno install, kernel, checkpoint and profile state | `crates/notebook-host` |
| Public library surface | `src/index.ts` |

The Deno asset manifest and checkpoint approach derive from
[howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff), revision
`a88a72bc68d133b6648da133ea9056cda70cf0c5`. Its MIT notice is retained in
`crates/notebook-host/HOWABOUA-LICENSE`.
