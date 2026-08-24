# pi-skills

`pi-skills` adds the `skill` tool. It loads a skill's `SKILL.md` into the
conversation after Pi has discovered that skill. The package does not scan a
skills directory and does not register resource URIs.

## Install

```sh
pi install ./harnesses/pi/agent/packages/pi-skills
```

The package can register its tool directly and also exposes the same execution
through the `pi-code-mode/sdk` adapter. Code Mode owns whether the tool is
direct or under `exec`.

## Discover and load a skill

Pi supplies loaded skills as commands named `skill:<name>`. `pi-skills` keeps
the exact suffix as the tool name and records the command's source path. It
uses only commands whose source is `skill` and whose name starts with
`skill:`. It does not search the filesystem for additional skills.

Call the tool with the exact name:

```json
{
  "name": "writing-for-agents"
}
```

The tool reads the corresponding `SKILL.md` and sends this contextual message
to Pi as a steering message:

```xml
<skill>
<name>writing-for-agents</name>
<path>/absolute/path/to/SKILL.md</path>
<!-- frontmatter-free SKILL.md body -->
</skill>
```

The model receives that message as user context. The tool result is the short
confirmation `Loaded skill "<name>".` plus versioned details about the
resolved path, frontmatter, sizes, and supporting files. If the name is not a
currently loaded `skill:<name>` command, the call fails with
`Unknown skill "<name>"`.

The contextual message stays in the Pi session history, so later turns can
follow the loaded instructions without loading the skill again.

The TUI keeps that hidden context out of the transcript. Its compact result is
a single `Skill · <name> · <tokens>` row; activating the row reveals the skill
body on an inset surface and activating it again collapses it.

### Frontmatter and supporting files

If `SKILL.md` starts with YAML frontmatter delimited by `---` lines, the
frontmatter is removed before the body is sent. A file without a closing
delimiter is left unchanged.

The loader walks the skill directory recursively and records supporting file
paths. It excludes `SKILL.md` and `agents/openai.yaml`; every other file counts,
including nested files. It records at most 256 paths. When more exist,
`supportingFilesTruncated` is true. It does not read or append the contents of
those files.

When at least one supporting file exists, the loaded body ends with:

```text
Skill directory: /absolute/path/to/skill
```

That directory line is not added when `SKILL.md` is the only file, or when the
only companion is `agents/openai.yaml`. Use the directory from the result to
open a needed asset, script, or reference yourself.

## Prompt catalogue

When visible skills exist, the package can add their names and descriptions to
the developer prompt. It never puts their filesystem paths in that catalogue.

Configure it with `pi-xsettings`:

```toml
[tools]
pi-skills.catalogVisibility = "when-active"
```

`catalogVisibility` accepts:

- `when-active` (default): include the catalogue when `skill` or `exec` is an
  active tool;
- `always`: include it in every prompt;
- `off`: do not include it.

Skills marked by Pi as unavailable for model invocation are omitted. The
catalogue tells the model to call `tools.skill` with an exact name and to load
only the supporting files required by the task.

Loaded instructions remain in model context but stay collapsed in the
transcript. Activate the skill row to read them without a duplicate context
message or card.

Without the xsettings host, the package uses the defaults above. Do not create
a second settings file.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| Skill discovery, frontmatter, and file listing | `src/skills.ts` |
| `skill` schema, loading call, and result details | `src/tools/skill/definition.ts` |
| Developer prompt catalogue | `src/prompt.ts` |
| Contextual message wrapper | `src/loaded-skill-context.ts` |
| Code Mode adapter | `src/code-mode-adapter.ts` via `pi-code-mode/sdk` |
| Settings declaration | `src/contributions/xsettings.ts` via `pi-xsettings/sdk` |
| TUI rendering | `src/tools/skill/presentation.ts` using `pi-libtui` |

## Troubleshooting

- **Unknown skill:** verify that Pi loaded the skill and registered a
  `skill:<name>` command. Use the exact suffix, including punctuation and
  case.
- **The catalogue is missing:** check `catalogVisibility`, and make sure
  `skill` or `exec` is active when the value is `when-active`.
- **The loaded instructions are not visible:** activate the skill row. The
  instructions are collapsed by default and still reach model context.
- **A referenced asset is not in the loaded text:** only `SKILL.md` is loaded.
  Use the reported `Skill directory` and load the required supporting file.
- **The tool cannot load a new skill by path:** that is intentional. Pi must
  discover and register the skill first.
