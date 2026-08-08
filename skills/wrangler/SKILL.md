---
name: wrangler
description: Cloudflare Workers CLI for deploying, developing, and managing Workers, KV, R2, D1, Vectorize, Hyperdrive, Workers AI, Containers, Queues, Workflows, Pipelines, and Secrets Store. Load before running wrangler commands to ensure correct syntax and best practices. Biases towards retrieval from Cloudflare docs over pre-trained knowledge.
---

# Wrangler CLI

Your knowledge of Wrangler CLI flags, config fields, and subcommands may be outdated. **Prefer retrieval over pre-training** for any Wrangler task — including the references in this skill, which are a snapshot and age the same way pre-training does.

## Retrieval sources

Fetch current information before writing or reviewing Wrangler commands and config:

| Source | How to retrieve | Use for |
|--------|----------------|---------|
| The installed CLI | `wrangler <command> --help` | Flags and subcommands for the version actually installed |
| Wrangler config schema | `node_modules/wrangler/config-schema.json` | Config fields, binding shapes, allowed values |
| Wrangler docs | `https://developers.cloudflare.com/workers/wrangler/` | CLI reference, migration notes |
| Cloudflare docs | Search tool or `https://developers.cloudflare.com/workers/` | API reference, compatibility dates and flags |

## Check the install first

```bash
wrangler --version   # requires v4.x+
```

Missing or older than v4: `npm install -D wrangler@latest`. Reach for Wrangler rather than hand-built API requests wherever it covers the operation.

## Key guidelines

- **Use `wrangler.jsonc`** — newer features are JSON-only.
- **Set a recent `compatibility_date`** (within 30 days). Check https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- **Run `wrangler types` after config changes** to refresh TypeScript bindings.
- **Local dev uses local storage simulation** unless a binding sets `remote: true`.
- **Profile startup with `wrangler check startup`** to catch Workers that exceed the startup time limit.
- **Use environments for staging and production** — define `env.staging` and `env.production` in config.

## Quick start: new Worker

```bash
npm create cloudflare@latest -- my-worker           # initialize
npm create cloudflare@latest -- my-app --framework=next   # or with a framework
```

## Reference

Read the file that matches the work:

- Writing or reviewing `wrangler.jsonc`, bindings, or generated types: [`references/configuration.md`](references/configuration.md)
- Running the dev server, deploying, managing secrets, rolling back a version, deploying Pages, or reading logs and analytics: [`references/develop-and-deploy.md`](references/develop-and-deploy.md)
- Working with KV, R2, D1, Vectorize, or Hyperdrive: [`references/storage.md`](references/storage.md)
- Working with Workers AI, Queues, Containers, Workflows, or Pipelines: [`references/compute.md`](references/compute.md)
- Writing tests, or diagnosing a failing build, deploy, or binding: [`references/testing-and-troubleshooting.md`](references/testing-and-troubleshooting.md)

## Upstream

This skill is vendored from Cloudflare. The split into `references/` is a local change; a re-vendor will arrive as one flat file.
