# Upstream

## Reference

- Repository: `IgorWarzocha/howaboua-pi-stuff`
- Commit: `b82cc162a144477050a039c456c36d7ce526be2d`
- Package: `packages/pi-codex-conversion`
- Source boundary: `src/tools/exec`
- Audit snapshot: `/tmp/howaboua-latest-audit`

## Owned port

- The package registers `exec_command` and `write_stdin` directly with Pi.
- The package has no Codex provider dependency.
- The root Cargo workspace owns the Rust bridge at `crates/exec-command`.
- The bridge path resolves from the root `target` directory.
- `PI_EXEC_COMMAND_BINARY` provides the test override.
- Pi lifecycle events terminate all bridge-owned sessions.
- Tool guidance stays in each tool description so direct and Code Mode calls
  receive the same instructions without a separate prompt message.
- Non-TTY commands use pipe stdio. A retained control PTY creates the isolated
  session and process group used for descendant termination.
- Direct and Code Mode calls share the same Pi tool definitions. The execution
  bridge registers adapters through `pi-code-mode/sdk`.
- Code Mode owns adapter hierarchy and exposure.

## Preserved behavior

- Pipe and PTY execution.
- Persistent numeric session identifiers.
- Empty polling and interactive input.
- Bounded retained output and bounded tool output.
- Separate stdout and stderr capture for pipe commands.
- Process termination during extension shutdown.
- Native process entries are reaped only after the final closed read. Bounded
  completed replay stays in the TypeScript manager.
