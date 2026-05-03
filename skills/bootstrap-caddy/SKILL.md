---
name: bootstrap-caddy
description: "Register a project in the local dev routing system."
argument-hint: "<project-name> [port]"
user-invocable: true
disable-model-invocation: true
---

# Bootstrap Caddy

Register a project in the local subdomain routing system (`https://<project>.localhost` via Caddy + dnsmasq).

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `bootstrap-caddy`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Register local routing by choosing a safe port, updating project config, adding Caddy config, and proving the route works.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: No route is done until the registry, project dev server, Caddy config, and reload check agree.

## Step 1: Parse arguments

First word = project name. Optional second = port override. Empty → AskUserQuestion (don't infer from context).

## Step 2: Check prerequisites

```bash
test -f $HOME/.config/dev-routing/Caddyfile && test -f $HOME/.config/dev-routing/ports.json && echo "OK" || echo "MISSING"
```

MISSING → stop: "Dev routing infrastructure not found at `$HOME/.config/dev-routing/`. Set it up via dotfiles first."

## Step 3: Read port registry

Read `$HOME/.config/dev-routing/ports.json`:

```json
{"nextPort": 5200, "projects": {"name": 5200, ...}}
```

Project already exists → output `https://<project>.localhost → localhost:<port>` and stop.

## Step 4: Assign port

User-provided → verify no collision. No port → use `nextPort`.

## Step 5: Update port registry

Add project + port. If auto-assigned, increment `nextPort`. Write back.

## Step 6: Create Caddy site config

Write `$HOME/.config/dev-routing/sites/<project>.caddy`:

```
<project>.localhost {
    reverse_proxy localhost:<port>
}
```

## Step 7: Configure project dev server

Skip if `$HOME/src/<project>` doesn't exist — just output the port for later.

If exists:

1. **vite.config.ts** — ensure `server: { port: Number(process.env.DEV_PORT) || undefined }`. Skip if present, replace if hardcoded.
2. **.env** (gitignored) — append `DEV_PORT=<port>` if missing.
3. **.env.example** (committed) — append `# DEV_PORT=5173` if missing.

Bun auto-loads `.env` — no extra setup needed.

## Step 8: Reload Caddy

```bash
caddy reload --config $HOME/.config/dev-routing/Caddyfile 2>&1 || caddy start --config $HOME/.config/dev-routing/Caddyfile 2>&1
```

## Step 9: Handoff

- **Dev URL:** `https://<project>.localhost`
- **Backend port:** `<port>`
- **Project configured:** yes / no (not found)
- **For .env:** `DEV_PORT=<port>`
