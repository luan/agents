# Developing and deploying Workers

Local dev, deployment, secrets, Pages, and observability. Confirm flags against `wrangler <command> --help` before running.

## Local Development

### Start Dev Server

```bash
# Local mode (default) - uses local storage simulation
wrangler dev

# With specific environment
wrangler dev --env staging

# Force local-only (disable remote bindings)
wrangler dev --local

# Remote mode - runs on Cloudflare edge (legacy)
wrangler dev --remote

# Custom port
wrangler dev --port 8787

# Live reload for HTML changes
wrangler dev --live-reload

# Test scheduled/cron handlers
wrangler dev --test-scheduled
# Then visit: http://localhost:8787/__scheduled
```

### Remote Bindings for Local Dev

Use `remote: true` in binding config to connect to real resources while running locally:

```jsonc
{
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "my-bucket", "remote": true }
  ],
  "ai": { "binding": "AI", "remote": true },
  "vectorize": [
    { "binding": "INDEX", "index_name": "my-index", "remote": true }
  ]
}
```

**Recommended remote bindings**: AI (required), Vectorize, Browser Rendering, mTLS, Images.

### Local Secrets

Create `.dev.vars` for local development secrets:

```
API_KEY=local-dev-key
DATABASE_URL=postgres://localhost:5432/dev
```

---

## Deployment

### Deploy Worker

```bash
# Deploy to production
wrangler deploy

# Deploy specific environment
wrangler deploy --env staging

# Dry run (validate without deploying)
wrangler deploy --dry-run

# Keep dashboard-set variables
wrangler deploy --keep-vars

# Minify code
wrangler deploy --minify
```

### Manage Secrets

> **Security**: Never pass secret values as command arguments or pipe them via `echo`.
> Use the interactive prompt (preferred), pipe from a file, or use `secret bulk`.
> Never output, log, or hardcode secret values in commands.

```bash
# Set secret — interactive prompt (preferred, wrangler will ask for the value securely)
wrangler secret put API_KEY

# Set secret from a file (useful for PEM keys, CI environments)
wrangler secret put PRIVATE_KEY < path/to/private-key.pem

# List secrets
wrangler secret list

# Delete secret
wrangler secret delete API_KEY

# Bulk secrets from JSON file (do not commit this file to version control)
wrangler secret bulk secrets.json
```

### Versions and Rollback

```bash
# List recent versions
wrangler versions list

# View specific version
wrangler versions view <VERSION_ID>

# Rollback to previous version
wrangler rollback

# Rollback to specific version
wrangler rollback <VERSION_ID>
```

---

## Secrets Store

### Manage Stores

```bash
# Create store
wrangler secrets-store store create my-store

# List stores
wrangler secrets-store store list

# Delete store
wrangler secrets-store store delete <STORE_ID>
```

### Manage Secrets in Store

```bash
# Add secret to store
wrangler secrets-store secret put <STORE_ID> my-secret

# List secrets in store
wrangler secrets-store secret list <STORE_ID>

# Get secret
wrangler secrets-store secret get <STORE_ID> my-secret

# Delete secret from store
wrangler secrets-store secret delete <STORE_ID> my-secret
```

### Config Binding

```jsonc
{
  "secrets_store_secrets": [
    {
      "binding": "MY_SECRET",
      "store_id": "<STORE_ID>",
      "secret_name": "my-secret"
    }
  ]
}
```

---

## Pages (Frontend Deployment)

```bash
# Create Pages project
wrangler pages project create my-site

# Deploy directory to Pages
wrangler pages deploy ./dist

# Deploy with specific branch
wrangler pages deploy ./dist --branch main

# List deployments
wrangler pages deployment list --project-name my-site
```

---

## Observability

### Tail Logs

```bash
# Stream live logs
wrangler tail

# Tail specific Worker
wrangler tail my-worker

# Filter by status
wrangler tail --status error

# Filter by search term
wrangler tail --search "error"

# JSON output
wrangler tail --format json
```

### Config Logging

```jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

---

