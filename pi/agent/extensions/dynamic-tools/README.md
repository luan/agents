# dynamic-tools

Dynamic activation rules for Pi tools.

The durable configuration lives in `config.json`. A rule edge activates child
tools after a parent tool result matches the configured predicates:

```json
{
  "id": "exec-command-tty-write-stdin",
  "from": "exec_command",
  "to": ["write_stdin"],
  "enabled": true,
  "when": {
    "input": [{ "path": "tty", "equals": true }],
    "result": [{ "path": "session_id", "exists": true }]
  },
  "freshRun": true,
  "continuation": "Continue with write_stdin session {{result.session_id}}."
}
```

- `roots`: tools to keep active whenever the extension applies policy.
- `rules`: DAG edges from a parent tool to child tools.
- Predicate paths are dot-separated object paths under `input` or `result`.
- `freshRun` is for Pi's per-run tool snapshot: after a matching parent result,
  the current tool loop is ended by the parent tool integration and the
  configured continuation starts a fresh run where the child tool is visible.

Use `/dynamic-tools` to configure roots, graph edges, and input/result
predicates in the TUI. The command can add, edit, enable, disable, delete, and
validate activation rules.
