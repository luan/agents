use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Error, ErrorCode, params, params_from_iter};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const DEFAULT_PREVIEW_BYTES: usize = 8_192;
const MAX_PREVIEW_BYTES: usize = 16_384;
const SUCCESS_TAIL_LINES: usize = 20;
const CHUNK_BYTES: usize = 8_192;
const CHUNK_OVERLAP_BYTES: usize = 256;
const CAPTURE_RETRIES: usize = 3;
const MAX_SEARCH_RESULTS: usize = 50;
const RETENTION_DAYS: i64 = 90;
const RETENTION_BYTES: i64 = 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct CoreRequest {
    command: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
struct CaptureParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "projectDir")]
    project_dir: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "sourceKind", default = "default_source_kind")]
    source_kind: String,
    label: Option<String>,
    #[serde(default)]
    metadata: Value,
    #[serde(rename = "originalCommand")]
    original_command: Option<String>,
    #[serde(rename = "executedCommand")]
    executed_command: Option<String>,
    cwd: Option<String>,
    output: String,
    #[serde(rename = "exitCode")]
    exit_code: Option<i64>,
    #[serde(rename = "terminalState")]
    terminal_state: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: Option<i64>,
    #[serde(rename = "previewBytes")]
    preview_bytes: Option<usize>,
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    query: Option<String>,
    queries: Option<Vec<String>>,
    #[serde(rename = "artifactId")]
    artifact_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    source: Option<String>,
    sort: Option<String>,
}

#[derive(Deserialize)]
struct StatusParams {
    #[serde(rename = "dbPath")]
    db_path: String,
}

#[derive(Deserialize)]
struct PurgeParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    confirm: bool,
    scope: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct FailureParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    operation: Option<String>,
}

fn default_source_kind() -> String {
    "command".to_string()
}

fn main() {
    let result = (|| -> Result<Value, String> {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|err| format!("failed to read request: {err}"))?;
        let request: CoreRequest =
            serde_json::from_str(&input).map_err(|err| format!("invalid request JSON: {err}"))?;
        match request.command.as_str() {
            "capture" => capture(request.params),
            "search" => search(request.params),
            "status" => status(request.params),
            "purge" => purge(request.params),
            "record_failure" => record_failure(request.params),
            command => Err(format!("unsupported command: {command}")),
        }
    })();

    match result {
        Ok(value) => write_response(value, false),
        Err(err) => write_response(Value::String(err), true),
    }
}

fn write_response(value: Value, is_error: bool) {
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    let mut response = json!({
        "ok": !is_error,
        "content": [{ "type": "text", "text": text }],
    });
    if is_error {
        response["isError"] = json!(true);
    }
    println!(
        "{}",
        serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string())
    );
}

fn capture(raw: Value) -> Result<Value, String> {
    let params: CaptureParams =
        serde_json::from_value(raw).map_err(|err| format!("invalid capture params: {err}"))?;
    let started = Instant::now();
    let mut conn = open_store(&params.db_path)?;
    let artifact_id = sha256_hex(params.output.as_bytes());
    let byte_count = params.output.len();
    let line_count = line_count(&params.output);
    let preview_limit = params
        .preview_bytes
        .unwrap_or(DEFAULT_PREVIEW_BYTES)
        .min(MAX_PREVIEW_BYTES);
    let preview = output_preview(&params, &artifact_id, byte_count, preview_limit);
    let returned_bytes = preview.len();
    let omitted_bytes = byte_count.saturating_sub(returned_bytes);

    for attempt in 0..CAPTURE_RETRIES {
        match capture_once(
            &mut conn,
            &params,
            &artifact_id,
            byte_count,
            line_count,
            returned_bytes,
            omitted_bytes,
        ) {
            Ok(()) => {
                let latency_ms = started.elapsed().as_millis() as i64;
                increment_metric(&conn, "capture_calls", 1)?;
                increment_metric(&conn, "captured_bytes", byte_count as i64)?;
                increment_metric(&conn, "returned_bytes", returned_bytes as i64)?;
                increment_metric(&conn, "omitted_bytes", omitted_bytes as i64)?;
                increment_metric(&conn, "capture_latency_ms", latency_ms)?;
                return Ok(json!({
                    "artifactId": artifact_id,
                    "byteCount": byte_count,
                    "lineCount": line_count,
                    "returnedBytes": returned_bytes,
                    "omittedBytes": omitted_bytes,
                    "preview": preview,
                }));
            }
            Err(err) if is_busy(&err) && attempt + 1 < CAPTURE_RETRIES => {
                thread::sleep(Duration::from_millis(25 * (attempt + 1) as u64));
            }
            Err(err) => return Err(format!("failed to capture output: {err}")),
        }
    }
    unreachable!("capture retries always return")
}

#[allow(clippy::too_many_arguments)]
fn capture_once(
    conn: &mut Connection,
    capture: &CaptureParams,
    artifact_id: &str,
    byte_count: usize,
    line_count: usize,
    returned_bytes: usize,
    omitted_bytes: usize,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let indexed = tx.execute(
        "INSERT OR IGNORE INTO artifacts (artifact_id, output, byte_count, line_count) VALUES (?1, ?2, ?3, ?4)",
        params![artifact_id, capture.output, byte_count as i64, line_count as i64],
    )? > 0;
    if indexed {
        for (index, chunk) in chunks(&capture.output).iter().enumerate() {
            tx.execute(
                "INSERT INTO artifact_chunks (artifact_id, chunk_index, content) VALUES (?1, ?2, ?3)",
                params![artifact_id, index as i64, chunk],
            )?;
        }
    }

    let label = capture
        .label
        .as_deref()
        .or(capture.original_command.as_deref())
        .or(capture.executed_command.as_deref())
        .unwrap_or(&capture.source_kind);
    let original_command = capture.original_command.as_deref().unwrap_or(label);
    let executed_command = capture.executed_command.as_deref().unwrap_or(label);
    let metadata_json =
        serde_json::to_string(&capture.metadata).unwrap_or_else(|_| "{}".to_string());
    tx.execute(
        "INSERT INTO captures (
            artifact_id, project_dir, session_id, original_command, executed_command, cwd,
            exit_code, terminal_state, started_at, elapsed_ms, source_kind, label,
            metadata_json, returned_bytes, omitted_bytes
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            COALESCE(?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?10,
            ?11, ?12, ?13, ?14, ?15
         )",
        params![
            artifact_id,
            capture.project_dir,
            capture.session_id,
            original_command,
            executed_command,
            capture.cwd.as_deref().unwrap_or(&capture.project_dir),
            capture.exit_code,
            capture.terminal_state,
            capture.started_at,
            capture.elapsed_ms.map(|value| value.max(0)),
            capture.source_kind,
            label,
            metadata_json,
            returned_bytes as i64,
            omitted_bytes as i64,
        ],
    )?;
    prune_store(&tx)?;
    tx.commit()
}

fn prune_store(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM captures WHERE julianday(started_at) < julianday('now', ?1)",
        params![format!("-{RETENTION_DAYS} days")],
    )?;
    cleanup_orphans(conn)?;
    loop {
        let bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(byte_count), 0) FROM artifacts",
            [],
            |row| row.get(0),
        )?;
        if bytes <= RETENTION_BYTES {
            break;
        }
        let deleted = conn.execute(
            "DELETE FROM captures WHERE id = (SELECT id FROM captures ORDER BY started_at ASC, id ASC LIMIT 1)",
            [],
        )?;
        if deleted == 0 {
            break;
        }
        cleanup_orphans(conn)?;
    }
    Ok(())
}

fn cleanup_orphans(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM artifact_chunks WHERE artifact_id NOT IN (SELECT DISTINCT artifact_id FROM captures)",
        [],
    )?;
    conn.execute(
        "DELETE FROM artifacts WHERE artifact_id NOT IN (SELECT DISTINCT artifact_id FROM captures)",
        [],
    )?;
    Ok(())
}

fn is_busy(err: &Error) -> bool {
    matches!(
        err,
        Error::SqliteFailure(error, _)
            if matches!(error.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn search(raw: Value) -> Result<Value, String> {
    let params: SearchParams =
        serde_json::from_value(raw).map_err(|err| format!("invalid search params: {err}"))?;
    if !Path::new(&params.db_path).exists() {
        return Ok(json!({ "results": [] }));
    }
    let started = Instant::now();
    let conn = open_store(&params.db_path)?;
    let mut queries = params.queries.unwrap_or_default();
    if let Some(query) = params.query.filter(|query| !query.trim().is_empty()) {
        queries.push(query);
    }
    let limit = params.limit.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let sort = params.sort.as_deref().unwrap_or("relevance");
    let mut results = Vec::new();
    let mut seen = HashSet::new();

    if queries.is_empty() {
        if let Some(artifact_id) = params.artifact_id.as_deref() {
            results.extend(read_artifact(
                &conn,
                artifact_id,
                limit,
                params.offset.unwrap_or(0),
            )?);
        }
    } else {
        for query in queries {
            for row in search_query(
                &conn,
                &query,
                limit,
                params.source.as_deref(),
                params.artifact_id.as_deref(),
                sort == "timeline",
            )? {
                let key = format!(
                    "{}:{}:{}",
                    row["captureId"], row["artifactId"], row["chunkIndex"]
                );
                if seen.insert(key) {
                    results.push(row);
                }
                if results.len() >= limit {
                    break;
                }
            }
            if results.len() >= limit {
                break;
            }
        }
    }

    let response = json!({ "results": results });
    let returned = serde_json::to_vec(&response)
        .map(|bytes| bytes.len())
        .unwrap_or(0) as i64;
    increment_metric(&conn, "search_calls", 1)?;
    increment_metric(&conn, "search_returned_bytes", returned)?;
    increment_metric(
        &conn,
        "search_latency_ms",
        started.elapsed().as_millis() as i64,
    )?;
    Ok(response)
}

fn read_artifact(
    conn: &Connection,
    artifact_id: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.source_kind, c.label, c.started_at, c.project_dir, c.session_id,
                    ac.chunk_index, ac.content, c.metadata_json
             FROM captures c
             JOIN artifact_chunks ac ON ac.artifact_id = c.artifact_id
             WHERE c.artifact_id = ?1
               AND c.id = (SELECT MAX(id) FROM captures WHERE artifact_id = ?1)
             ORDER BY ac.chunk_index ASC LIMIT ?2 OFFSET ?3",
        )
        .map_err(|err| format!("failed to prepare artifact read: {err}"))?;
    let rows = stmt
        .query_map(params![artifact_id, limit as i64, offset as i64], |row| {
            let metadata: String = row.get(8)?;
            Ok(json!({
                "captureId": row.get::<_, i64>(0)?,
                "artifactId": artifact_id,
                "sourceKind": row.get::<_, String>(1)?,
                "label": row.get::<_, String>(2)?,
                "timestamp": row.get::<_, String>(3)?,
                "source": row.get::<_, String>(4)?,
                "sessionId": row.get::<_, Option<String>>(5)?,
                "chunkIndex": row.get::<_, i64>(6)?,
                "snippet": row.get::<_, String>(7)?,
                "metadata": serde_json::from_str::<Value>(&metadata).unwrap_or_else(|_| json!({})),
            }))
        })
        .map_err(|err| format!("failed to read artifact: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to decode artifact: {err}"))
}

fn search_query(
    conn: &Connection,
    query: &str,
    limit: usize,
    source: Option<&str>,
    artifact_id: Option<&str>,
    timeline: bool,
) -> Result<Vec<Value>, String> {
    let fts = fts_query(query);
    if fts.is_empty() {
        return Ok(Vec::new());
    }
    let order = if timeline {
        "captures.started_at DESC, artifact_chunks.chunk_index ASC"
    } else {
        "bm25(artifact_chunks), captures.started_at DESC"
    };
    let mut sql = String::from(
        "SELECT captures.id, artifact_chunks.artifact_id, artifact_chunks.chunk_index,
                artifact_chunks.content, captures.source_kind, captures.label,
                captures.started_at, captures.project_dir, captures.session_id,
                captures.metadata_json
         FROM artifact_chunks JOIN captures ON captures.artifact_id = artifact_chunks.artifact_id
         WHERE artifact_chunks MATCH ?1",
    );
    let mut values = vec![SqlValue::Text(fts)];
    if let Some(artifact_id) = artifact_id {
        values.push(SqlValue::Text(artifact_id.to_string()));
        sql.push_str(&format!(" AND captures.artifact_id = ?{}", values.len()));
    }
    if let Some(source) = source {
        values.push(SqlValue::Text(format!("%{source}%")));
        let index = values.len();
        sql.push_str(&format!(
            " AND (captures.project_dir LIKE ?{index} OR captures.label LIKE ?{index} OR captures.metadata_json LIKE ?{index})"
        ));
    }
    values.push(SqlValue::Integer(limit as i64));
    sql.push_str(&format!(" ORDER BY {order} LIMIT ?{}", values.len()));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("failed to prepare search: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(values), |row| {
            let content: String = row.get(3)?;
            let metadata: String = row.get(9)?;
            Ok(json!({
                "captureId": row.get::<_, i64>(0)?,
                "artifactId": row.get::<_, String>(1)?,
                "chunkIndex": row.get::<_, i64>(2)?,
                "sourceKind": row.get::<_, String>(4)?,
                "label": row.get::<_, String>(5)?,
                "timestamp": row.get::<_, String>(6)?,
                "source": row.get::<_, String>(7)?,
                "sessionId": row.get::<_, Option<String>>(8)?,
                "snippet": compact_snippet(&content, query),
                "metadata": serde_json::from_str::<Value>(&metadata).unwrap_or_else(|_| json!({})),
            }))
        })
        .map_err(|err| format!("failed to run search: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to decode search result: {err}"))
}

fn status(raw: Value) -> Result<Value, String> {
    let params: StatusParams =
        serde_json::from_value(raw).map_err(|err| format!("invalid status params: {err}"))?;
    let existed = Path::new(&params.db_path).exists();
    if !existed {
        return Ok(empty_status(&params.db_path));
    }
    let conn = open_store(&params.db_path)?;
    let metrics = read_metrics(&conn)?;
    let mut by_kind = HashMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT source_kind, COUNT(*) FROM captures GROUP BY source_kind ORDER BY source_kind",
        )
        .map_err(|err| format!("failed to prepare source status: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|err| format!("failed to read source status: {err}"))?;
    for row in rows {
        let (kind, count) = row.map_err(|err| err.to_string())?;
        by_kind.insert(kind, count);
    }
    Ok(json!({
        "dbPath": params.db_path,
        "exists": true,
        "artifacts": scalar(&conn, "SELECT COUNT(*) FROM artifacts")?,
        "captures": scalar(&conn, "SELECT COUNT(*) FROM captures")?,
        "chunks": scalar(&conn, "SELECT COUNT(*) FROM artifact_chunks")?,
        "indexedBytes": scalar(&conn, "SELECT COALESCE(SUM(byte_count), 0) FROM artifacts")?,
        "capturedBytes": metric(&metrics, "captured_bytes"),
        "returnedBytes": metric(&metrics, "returned_bytes"),
        "omittedBytes": metric(&metrics, "omitted_bytes"),
        "searchReturnedBytes": metric(&metrics, "search_returned_bytes"),
        "captureCalls": metric(&metrics, "capture_calls"),
        "searchCalls": metric(&metrics, "search_calls"),
        "captureFailures": metric(&metrics, "capture_failures"),
        "searchFailures": metric(&metrics, "search_failures"),
        "captureLatencyMs": metric(&metrics, "capture_latency_ms"),
        "searchLatencyMs": metric(&metrics, "search_latency_ms"),
        "databaseBytes": database_bytes(&params.db_path),
        "retentionDays": RETENTION_DAYS,
        "retentionBytes": RETENTION_BYTES,
        "bySourceKind": by_kind,
    }))
}

fn empty_status(db_path: &str) -> Value {
    json!({
        "dbPath": db_path,
        "exists": false,
        "artifacts": 0,
        "captures": 0,
        "chunks": 0,
        "indexedBytes": 0,
        "capturedBytes": 0,
        "returnedBytes": 0,
        "omittedBytes": 0,
        "searchReturnedBytes": 0,
        "captureCalls": 0,
        "searchCalls": 0,
        "captureFailures": 0,
        "searchFailures": 0,
        "captureLatencyMs": 0,
        "searchLatencyMs": 0,
        "databaseBytes": 0,
        "retentionDays": RETENTION_DAYS,
        "retentionBytes": RETENTION_BYTES,
        "bySourceKind": {},
    })
}

fn purge(raw: Value) -> Result<Value, String> {
    let params: PurgeParams =
        serde_json::from_value(raw).map_err(|err| format!("invalid purge params: {err}"))?;
    if !params.confirm {
        return Err("purge requires confirm: true".to_string());
    }
    let Some(scope) = params.scope.as_deref() else {
        return Err("purge requires explicit scope: session or project".to_string());
    };
    match scope {
        "project" => {
            if params.session_id.is_some() {
                return Err("project purge must not include sessionId".to_string());
            }
            for suffix in ["", "-wal", "-shm"] {
                let path = format!("{}{}", params.db_path, suffix);
                if Path::new(&path).exists() {
                    fs::remove_file(&path)
                        .map_err(|err| format!("failed to remove {path}: {err}"))?;
                }
            }
            Ok(json!({ "scope": "project", "purged": true }))
        }
        "session" => {
            let session_id = params
                .session_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "session purge requires sessionId".to_string())?;
            if !Path::new(&params.db_path).exists() {
                return Ok(json!({ "scope": "session", "sessionId": session_id, "deleted": 0 }));
            }
            let mut conn = open_store(&params.db_path)?;
            let tx = conn
                .transaction()
                .map_err(|err| format!("failed to start purge transaction: {err}"))?;
            let deleted = tx
                .execute(
                    "DELETE FROM captures WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(|err| format!("failed to purge session captures: {err}"))?;
            cleanup_orphans(&tx)
                .map_err(|err| format!("failed to clean purged artifacts: {err}"))?;
            tx.commit()
                .map_err(|err| format!("failed to commit session purge: {err}"))?;
            Ok(json!({ "scope": "session", "sessionId": session_id, "deleted": deleted }))
        }
        _ => Err("purge scope must be session or project".to_string()),
    }
}

fn record_failure(raw: Value) -> Result<Value, String> {
    let params: FailureParams =
        serde_json::from_value(raw).map_err(|err| format!("invalid failure params: {err}"))?;
    let conn = open_store(&params.db_path)?;
    let key = match params.operation.as_deref() {
        Some("search") => "search_failures",
        _ => "capture_failures",
    };
    increment_metric(&conn, key, 1)?;
    Ok(json!({ "recorded": true }))
}

fn open_store(db_path: &str) -> Result<Connection, String> {
    if db_path.trim().is_empty() {
        return Err("dbPath is required".to_string());
    }
    if let Some(parent) = Path::new(db_path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create database directory {}: {err}",
                parent.display()
            )
        })?;
    }
    for attempt in 0..CAPTURE_RETRIES {
        let conn =
            Connection::open(db_path).map_err(|err| format!("failed to open {db_path}: {err}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|err| format!("failed to configure store busy timeout: {err}"))?;
        match initialize_store(&conn) {
            Ok(()) => return Ok(conn),
            Err(err) if is_busy(&err) && attempt + 1 < CAPTURE_RETRIES => {
                thread::sleep(Duration::from_millis(25 * (attempt + 1) as u64));
            }
            Err(err) => return Err(format!("failed to initialize v2 store: {err}")),
        }
    }
    unreachable!("store initialization retries always return")
}

fn initialize_store(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS artifacts (
            artifact_id TEXT PRIMARY KEY,
            output TEXT NOT NULL,
            byte_count INTEGER NOT NULL,
            line_count INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
            project_dir TEXT NOT NULL,
            session_id TEXT,
            original_command TEXT NOT NULL,
            executed_command TEXT NOT NULL,
            cwd TEXT NOT NULL,
            exit_code INTEGER,
            terminal_state TEXT,
            started_at TEXT NOT NULL,
            elapsed_ms INTEGER,
            source_kind TEXT NOT NULL DEFAULT 'command',
            label TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            returned_bytes INTEGER NOT NULL DEFAULT 0,
            omitted_bytes INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS captures_artifact_idx ON captures(artifact_id);
         CREATE INDEX IF NOT EXISTS captures_session_idx ON captures(session_id);
         CREATE INDEX IF NOT EXISTS captures_started_idx ON captures(started_at DESC);
         CREATE INDEX IF NOT EXISTS captures_kind_idx ON captures(source_kind, started_at DESC);
         CREATE VIRTUAL TABLE IF NOT EXISTS artifact_chunks USING fts5(
            artifact_id UNINDEXED,
            chunk_index UNINDEXED,
            content
         );
         CREATE TABLE IF NOT EXISTS telemetry (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    ensure_column(
        conn,
        "captures",
        "source_kind",
        "TEXT NOT NULL DEFAULT 'command'",
    )?;
    ensure_column(conn, "captures", "label", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        conn,
        "captures",
        "metadata_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        conn,
        "captures",
        "returned_bytes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "captures",
        "omitted_bytes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))
}

fn increment_metric(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO telemetry (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value",
        params![key, value.max(0)],
    )
    .map(|_| ())
    .map_err(|err| format!("failed to record telemetry: {err}"))
}

fn read_metrics(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM telemetry")
        .map_err(|err| format!("failed to prepare telemetry status: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|err| format!("failed to read telemetry status: {err}"))?;
    let mut metrics = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|err| err.to_string())?;
        metrics.insert(key, value);
    }
    Ok(metrics)
}

fn metric(metrics: &HashMap<String, i64>, key: &str) -> i64 {
    *metrics.get(key).unwrap_or(&0)
}

fn database_bytes(db_path: &str) -> u64 {
    ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| fs::metadata(format!("{db_path}{suffix}")).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn scalar(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|err| format!("failed to read status: {err}"))
}

fn output_preview(
    params: &CaptureParams,
    artifact_id: &str,
    byte_count: usize,
    max_bytes: usize,
) -> String {
    if params.output.len() <= max_bytes {
        return params.output.clone();
    }
    let failed = params.exit_code.is_some_and(|code| code != 0)
        || matches!(
            params.terminal_state.as_deref(),
            Some("timed_out" | "cancelled" | "session_error")
        );
    let notice = format!(
        "Captured {} as artifact {}; showing {}. Use cg_search with artifactId for full output.\n",
        human_bytes(byte_count as u64),
        artifact_id,
        if failed {
            "diagnostic tail"
        } else {
            "final 20 lines"
        },
    );
    if notice.len() >= max_bytes {
        return prefix_bytes(&notice, max_bytes);
    }
    let remaining = max_bytes - notice.len();
    let tail = if failed {
        suffix_bytes(&params.output, remaining)
    } else {
        suffix_bytes(&last_lines(&params.output, SUCCESS_TAIL_LINES), remaining)
    };
    format!("{notice}{tail}")
}

fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn last_lines(text: &str, count: usize) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn chunks(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut result = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = chunk_end(text, start);
        result.push(text[start..end].to_string());
        if end == text.len() {
            break;
        }
        start = chunk_start(text, end);
    }
    result
}

fn chunk_end(text: &str, start: usize) -> usize {
    let mut end = (start + CHUNK_BYTES).min(text.len());
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    let minimum = start + CHUNK_BYTES / 2;
    text[start..end]
        .char_indices()
        .filter_map(|(index, ch)| {
            (ch.is_whitespace() || (!ch.is_alphanumeric() && ch != '_'))
                .then_some(start + index + ch.len_utf8())
        })
        .rfind(|index| *index >= minimum)
        .unwrap_or(end)
}

fn chunk_start(text: &str, end: usize) -> usize {
    let mut start = end.saturating_sub(CHUNK_OVERLAP_BYTES);
    while start < end && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..end]
        .char_indices()
        .filter_map(|(index, ch)| {
            (ch.is_whitespace() || (!ch.is_alphanumeric() && ch != '_'))
                .then_some(start + index + ch.len_utf8())
        })
        .rfind(|index| *index < end)
        .unwrap_or(start)
}

fn prefix_bytes(text: &str, max_bytes: usize) -> String {
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn suffix_bytes(text: &str, max_bytes: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().count()
    }
}

fn fts_query(query: &str) -> String {
    query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn compact_snippet(content: &str, query: &str) -> String {
    let needle = query
        .split_whitespace()
        .find(|term| !term.is_empty())
        .unwrap_or("");
    let index = if needle.is_empty() {
        0
    } else {
        content
            .to_ascii_lowercase()
            .find(&needle.to_ascii_lowercase())
            .unwrap_or(0)
    };
    let start = content[..index]
        .rfind('\n')
        .map(|value| value + 1)
        .unwrap_or(index);
    let end = (start + 1200).min(content.len());
    prefix_bytes(&content[start..], end - start)
        .trim()
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
