# Blueprints

All structured artifacts (specs, plans, reviews, reports, docs) live in the blueprints vault (`$CT_BLUEPRINTS_DIR`, default `~/blueprints/`) via the `ct` tool. The blueprints repo is a separate git repository — `ct` handles commit+push automatically after every write.

**Principle:** The vault is canonical. Repos may snapshot frozen copies for contributor access, but edits happen in the vault.

## Layout

```
~/blueprints/<project>/
  spec/       # target-state specifications
  plan/       # implementation plans
  review/     # code review findings
  report/     # post-implementation summaries
  docs/       # permanent reference docs (architecture, guides)
  archive/    # consumed artifacts from all types
```

## Commands

Every artifact operation lives under `ct vault`. Use `-t <type>` to scope to one kind (`spec`, `plan`, `review`, `report`, `doc`); the default `-t all` operates across kinds.

| Operation    | Command                                              |
| ------------ | ---------------------------------------------------- |
| Project name | `ct repo project`                                    |
| Create       | `ct vault create -t <type> --topic "..."`            |
| Read         | `ct vault read [-t <type>] <stem>`                   |
| List         | `ct vault list [-t <type>] [--all]`                  |
| Archive      | `ct vault archive [-t <type>] <stem>`                |
| Prune        | `ct vault prune [-t <type>] [--days N]`              |
| Comments     | `ct vault comments [-t <type>] <stem>`               |
| Rename       | `ct vault rename [-t <type>] <stem> <new-slug>`      |
| Retag        | `ct vault retag [-t <type>] <stem>`                  |
| Commit edits | `ct vault commit <path>`                             |
| Status       | `ct vault status`                                    |

## Linking (Obsidian)

The blueprints repo is an Obsidian vault. Use `[[wiki-links]]` to connect related artifacts.

- **`--source`**: When creating an artifact derived from another (plan from spec, review against spec), pass `--source <stem>` to `ct vault create`. This adds `source: "[[stem]]"` to frontmatter.
- **Related artifacts**: After creating an artifact, run `ct vault related "<topic>"`. If matches found, append a `## Related` section with the wiki-links.
- **Inline links**: When referencing another artifact in body text, use `[[stem]]` (filename without extension or path — Obsidian resolves across the vault).
- Keep linking shallow — don't read related files to summarize them, just link by name.

| Operation    | Command                                                  |
| ------------ | -------------------------------------------------------- |
| Find related | `ct vault related "<topic>"`                             |
| Link source  | `ct vault create -t <type> --source "<stem>" ...`        |
| Check links  | `ct vault check`                                         |
| Search       | `ct vault search "<query>"`                              |

## Tags

All artifacts have `tags:` in frontmatter. `ct` auto-derives `type/` and `project/` tags; add domain/stage tags via `--tags`.

**Auto-derived** (always added by `ct vault create`):

- `type/spec`, `type/plan`, `type/review`, `type/report`, `type/doc`
- `project/<name>` (from project path)

**User-supplied** (via `--tags "domain/combat,stage/research"`):

- `domain/<area>` — combat, lua, ui, network, etc.
- `stage/<phase>` — research, implementing, shipped, stale
- Any freeform tag

**Permanent docs** in `docs/` use `type/doc` tag. These are reference documents (architecture, API guides) — not workflow artifacts.

## Dives

A dive is a vision-level spec linked to a hub spec. It lives in a sibling `dive/` folder so the top-level `spec/` list stays scannable as "major things we're building." Dives share the `type/spec` tag.

- Create via `dive: true` (MCP `create`) or `--dive` (CLI). Both require a `source` — a dive without a hub link is rejected.
- Dive-only for specs; rejected for other artifact kinds.
- Slug convention: `<hub-slug>-<subtopic>` so dives from the same hub sort together.
- `ct vault list -t spec` hides dives by default; `--include-dives` to see them. `read` (MCP) / `ct vault read <stem>` finds dives by bare stem.
- Archive preserves the subfolder: dives archive to `archive/<project>/dive/`.

## Writing artifact bodies

`ct vault create` scaffolds the file with frontmatter only. The body is written by editing the returned path with Edit/apply_patch, and pushed via `ct vault commit <path>`.

The MCP `vault` server exposes the same operations as bare-name tools (`create`, `read`, `list`, `archive`, `prune`, `comments`, `rename`, `retag`, `commit`, `search`, `related`, `check`, `status`). Prefer the MCP path — it bypasses shell quoting entirely.

```
create { kind: "spec", topic: "..." }   # returns path
# Edit/apply_patch writes the body to the returned path
commit { path: "<returned path>" }      # commit+push
```

## Rules

- Use the MCP `create` + Edit + `commit` flow, or `ct vault create` + Edit + `ct vault commit` — never write vault files directly.
- `--project` auto-detects from cwd (git toplevel, falls back to cwd). Pass it only to target a different project.
- If push fails during commit+push, stop and report to user. Never force-push.
- `ct` errors if the vault directory is missing — initialize `~/blueprints/` (or `$CT_BLUEPRINTS_DIR`) as a git repo before first use.
- Set `CT_BLUEPRINTS_DIR` to override the default `~/blueprints/` location.
