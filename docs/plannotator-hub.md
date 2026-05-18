# Plannotator hub for Pi

This repo ships a Pi-side Plannotator hub that keeps upstream Plannotator
unchanged while solving two operational problems:

1. upstream Plannotator starts a fresh localhost server for every plan/review
2. those random localhost ports are not remotely accessible on their own

The hub exposes one stable public origin and proxies active Plannotator sessions
through it.

## What it does

- keeps real Plannotator review servers on random `127.0.0.1:<port>` listeners
- runs a hub on one fixed port, default `19432`
- registers each new backend through a browser shim
- serves a picker UI at `/`
- proxies each session at `/s/<session-id>/`

This matters because upstream Plannotator's browser bundles call absolute API
paths like `/api/plan` and `/api/feedback`. The hub rewrites those root paths
to `/s/<session-id>/api/...` on the way out, so the browser stays on the single
public origin.

## Files

- `pi/agent/extensions/plannotator-hub/index.ts`
  - Pi extension that wires environment variables for the hub
- `pi/agent/extensions/plannotator-hub/browser-shim.cjs`
  - executable opened by upstream Plannotator instead of a normal browser
- `pi/agent/extensions/plannotator-hub/hub-server.cjs`
  - standalone proxy + picker UI process

## How the wiring works

When Pi starts a session, the local extension:

- forces `PLANNOTATOR_REMOTE=false`
- clears `PLANNOTATOR_PORT`
- points Plannotator's browser launcher at the local browser shim
- stores current Pi session metadata in env vars so the shim can label entries

That keeps upstream Plannotator off the fixed public port and ensures it opens
random loopback listeners only.

When upstream Plannotator tries to open a browser tab, it actually launches the
browser shim:

1. ensure the hub is running on `PLANNOTATOR_HUB_PORT`
2. probe the backend (`/api/plan` or `/api/diff`) to identify plan/review mode
3. register the backend with the hub
4. optionally open the public session URL in a local browser

Remote SSH sessions normally do not have a GUI browser, so step 4 is best
effort.

## Pi-native configuration

Use Pi settings as the primary source of truth. This repo ships the shared
default in `pi/agent/settings.json`, which `just setup` links into Pi's global
settings location.

The shared default is:

```json
{
  "plannotatorHub": {
    "publicUrl": "http://127.0.0.1:19432",
    "port": 19432,
    "bind": "127.0.0.1"
  }
}
```

If you want a personal remote tunnel, override `plannotatorHub.publicUrl` in a
local `.pi/settings.json`. Project settings override global settings, matching
normal Pi behavior.

After changing the `plannotatorHub` block, run `/reload` in Pi or start a new
Pi session so the extension re-reads settings and restarts the hub with the new
values.

## Default configuration

When no `plannotatorHub` settings exist, the extension falls back to:

```bash
PLANNOTATOR_HUB_PORT=19432
PLANNOTATOR_HUB_BIND=127.0.0.1
PLANNOTATOR_HUB_PUBLIC_URL=http://127.0.0.1:19432
```

### Fallback environment override

For ad hoc launches outside settings, you can still set a custom public origin:

```bash
PLANNOTATOR_HUB_PUBLIC_URL=https://your-plannotator-host.example.com
```

Settings override stale inherited hub env inside the running Pi process. The
env var remains useful for one-off tests.

## Optional remote tunnel setup

If you want remote access, point your own tunnel or reverse proxy at the local
hub:

- origin service: `http://127.0.0.1:19432`

No other ports need to be exposed. The hub proxies the random Plannotator
backends through the same origin.

Because the hub is a generic proxy to active localhost Plannotator sessions,
put authentication in front of it. Cloudflare Access is the intended guardrail.

The hub now starts automatically when Pi starts a session. If Pi is not
running, your remote origin still has nothing local to proxy to, so a gateway
error is expected.

## Optional environment variables

### `PLANNOTATOR_HUB_OPEN_BROWSER`

If set, the shim uses this command to open the public session URL after
registration. This is mainly for local desktop Pi sessions.

### `PLANNOTATOR_HUB_SECRET_FILE`

Path to the local shared secret used by the browser shim when registering
backends with the hub. Default:

```bash
~/.pi/plannotator-hub-secret
```

The secret protects the registration endpoint from arbitrary public callers.

### `PLANNOTATOR_HUB_DISABLED`

Set to `1` or `true` to disable the hub wiring entirely.

## Local workflow

1. run `just setup`
2. run `/reload` or start a fresh Pi session
3. open `http://127.0.0.1:19432/`
4. trigger any Plannotator plan/review/annotate flow
5. pick the session from the hub UI

If you want remote access instead, add a local `.pi/settings.json` override
with your own `plannotatorHub.publicUrl` and point your tunnel at
`127.0.0.1:19432`.

## Current limitations

- the picker UI is intentionally simple: list + open
- session registry is in-memory inside the hub process
- if the hub restarts, existing backends must register again on the next browser launch
- HTML rewriting assumes upstream Plannotator continues to reference root
  endpoints like `/api/...` and `/favicon.svg`

## Why this is upstreamable

Most of the work is setup and orchestration, not Plannotator core changes:

- a fixed-port hub process
- a browser shim
- path rewriting for root-relative API calls
- Pi-side settings + environment wiring

That means the shape can move upstream later without changing the semantics of
Plannotator's own plan/review servers.
