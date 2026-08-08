# Wrangler storage products

KV, R2, D1, Vectorize, and Hyperdrive. Confirm flags against `wrangler <command> --help` before running.

## KV (Key-Value Store)

### Manage Namespaces

```bash
# Create namespace
wrangler kv namespace create MY_KV

# List namespaces
wrangler kv namespace list

# Delete namespace
wrangler kv namespace delete --namespace-id <ID>
```

### Manage Keys

```bash
# Put value
wrangler kv key put --namespace-id <ID> "key" "value"

# Put with expiration (seconds)
wrangler kv key put --namespace-id <ID> "key" "value" --expiration-ttl 3600

# Get value
wrangler kv key get --namespace-id <ID> "key"

# List keys
wrangler kv key list --namespace-id <ID>

# Delete key
wrangler kv key delete --namespace-id <ID> "key"

# Bulk put from JSON
wrangler kv bulk put --namespace-id <ID> data.json
```

### Config Binding

```jsonc
{
  "kv_namespaces": [
    { "binding": "CACHE", "id": "<NAMESPACE_ID>" }
  ]
}
```

---

## R2 (Object Storage)

### Manage Buckets

```bash
# Create bucket
wrangler r2 bucket create my-bucket

# Create with location hint
wrangler r2 bucket create my-bucket --location wnam

# List buckets
wrangler r2 bucket list

# Get bucket info
wrangler r2 bucket info my-bucket

# Delete bucket
wrangler r2 bucket delete my-bucket
```

### Manage Objects

```bash
# Upload object
wrangler r2 object put my-bucket/path/file.txt --file ./local-file.txt

# Download object
wrangler r2 object get my-bucket/path/file.txt

# Delete object
wrangler r2 object delete my-bucket/path/file.txt
```

### Config Binding

```jsonc
{
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "my-bucket" }
  ]
}
```

---

## D1 (SQL Database)

### Manage Databases

```bash
# Create database
wrangler d1 create my-database

# Create with location
wrangler d1 create my-database --location wnam

# List databases
wrangler d1 list

# Get database info
wrangler d1 info my-database

# Delete database
wrangler d1 delete my-database
```

### Execute SQL

```bash
# Execute SQL command (remote)
wrangler d1 execute my-database --remote --command "SELECT * FROM users"

# Execute SQL file (remote)
wrangler d1 execute my-database --remote --file ./schema.sql

# Execute locally
wrangler d1 execute my-database --local --command "SELECT * FROM users"
```

### Migrations

```bash
# Create migration
wrangler d1 migrations create my-database create_users_table

# List pending migrations
wrangler d1 migrations list my-database --local

# Apply migrations locally
wrangler d1 migrations apply my-database --local

# Apply migrations to remote
wrangler d1 migrations apply my-database --remote
```

### Export/Backup

```bash
# Export schema and data
wrangler d1 export my-database --remote --output backup.sql

# Export schema only
wrangler d1 export my-database --remote --output schema.sql --no-data
```

### Config Binding

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-database",
      "database_id": "<DATABASE_ID>",
      "migrations_dir": "./migrations"
    }
  ]
}
```

---

## Vectorize (Vector Database)

### Manage Indexes

```bash
# Create index with dimensions
wrangler vectorize create my-index --dimensions 768 --metric cosine

# Create with preset (auto-configures dimensions/metric)
wrangler vectorize create my-index --preset @cf/baai/bge-base-en-v1.5

# List indexes
wrangler vectorize list

# Get index info
wrangler vectorize get my-index

# Delete index
wrangler vectorize delete my-index
```

### Manage Vectors

```bash
# Insert vectors from NDJSON file
wrangler vectorize insert my-index --file vectors.ndjson

# Query vectors
wrangler vectorize query my-index --vector "[0.1, 0.2, ...]" --top-k 10
```

### Config Binding

```jsonc
{
  "vectorize": [
    { "binding": "SEARCH_INDEX", "index_name": "my-index" }
  ]
}
```

---

## Hyperdrive (Database Accelerator)

### Manage Configs

```bash
# Create config
wrangler hyperdrive create my-hyperdrive \
  --origin-host db.example.com \
  --origin-port 5432 \
  --database my-database \
  --origin-user db-user \
  --origin-password "$DB_PASSWORD"

# Or using a connection string from an environment variable
wrangler hyperdrive create my-hyperdrive \
  --connection-string "$HYPERDRIVE_CONNECTION_STRING"

# List configs
wrangler hyperdrive list

# Get config details
wrangler hyperdrive get <HYPERDRIVE_ID>

# Update config
wrangler hyperdrive update <HYPERDRIVE_ID> \
  --origin-password "$DB_PASSWORD"

# Delete config
wrangler hyperdrive delete <HYPERDRIVE_ID>
```

### Config Binding

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }
  ]
}
```

---

