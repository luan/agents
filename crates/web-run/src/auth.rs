use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use crypto_box::SecretKey as Curve25519SecretKey;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};

use crate::http::{bounded_error_body, client};

pub enum Auth {
    Bearer {
        access_token: String,
        account_id: String,
    },
    AgentIdentity(AgentIdentityAuth),
}

impl Auth {
    pub fn account_id(&self) -> &str {
        match self {
            Self::Bearer { account_id, .. } => account_id,
            Self::AgentIdentity(auth) => &auth.record.account_id,
        }
    }

    pub fn is_fedramp(&self) -> bool {
        match self {
            Self::Bearer { .. } => false,
            Self::AgentIdentity(auth) => auth.record.chatgpt_account_is_fedramp,
        }
    }

    pub fn authorization_header(&self) -> Result<String> {
        match self {
            Self::Bearer { access_token, .. } => Ok(format!("Bearer {access_token}")),
            Self::AgentIdentity(auth) => auth.authorization_header(),
        }
    }
}

pub struct AgentIdentityAuth {
    record: AgentIdentityRecord,
    task_id: String,
}

#[derive(Deserialize)]
struct AgentIdentityRecord {
    agent_runtime_id: String,
    agent_private_key: String,
    account_id: String,
    #[serde(default)]
    chatgpt_account_is_fedramp: bool,
}

#[derive(Deserialize)]
struct RegisterTaskResponse {
    #[serde(default, alias = "taskId")]
    task_id: Option<String>,
    #[serde(default, alias = "encryptedTaskId")]
    encrypted_task_id: Option<String>,
}

fn pi_agent_dir() -> PathBuf {
    env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
        .unwrap_or_else(|| PathBuf::from(".pi/agent"))
}

fn account_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("chatgpt_account_id")
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| auth.get("chatgpt_account_id"))
        })
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
}

fn agent_record(jwt: &str) -> Result<AgentIdentityRecord> {
    let payload = jwt
        .split('.')
        .nth(1)
        .context("agent identity JWT is missing its payload")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .context("agent identity JWT payload is not valid base64url")?;
    serde_json::from_slice(&bytes).context("agent identity JWT payload is not valid JSON")
}

fn signing_key(record: &AgentIdentityRecord) -> Result<SigningKey> {
    let bytes = STANDARD
        .decode(&record.agent_private_key)
        .context("agent identity private key is not valid base64")?;
    SigningKey::from_pkcs8_der(&bytes).context("agent identity private key is not valid PKCS#8")
}

fn sign(record: &AgentIdentityRecord, payload: &str) -> Result<String> {
    Ok(STANDARD.encode(signing_key(record)?.sign(payload.as_bytes()).to_bytes()))
}

fn decrypt_task_id(record: &AgentIdentityRecord, encrypted: &str) -> Result<String> {
    let signing_key = signing_key(record)?;
    let digest = Sha512::digest(signing_key.to_bytes());
    let mut secret = [0_u8; 32];
    secret.copy_from_slice(&digest[..32]);
    secret[0] &= 0b1111_1000;
    secret[31] &= 0b0111_1111;
    secret[31] |= 0b0100_0000;
    let encrypted = STANDARD
        .decode(encrypted)
        .context("encrypted task id is not valid base64")?;
    let decrypted = Curve25519SecretKey::from(secret)
        .unseal(&encrypted)
        .map_err(|_| anyhow::anyhow!("failed to decrypt agent identity task id"))?;
    String::from_utf8(decrypted).context("decrypted agent identity task id is not UTF-8")
}

async fn load_agent_identity(jwt: &str) -> Result<Auth> {
    let record = agent_record(jwt)?;
    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let signature = sign(&record, &format!("{}:{timestamp}", record.agent_runtime_id))?;
    let base_url = env::var("CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://auth.openai.com/api/accounts".to_owned());
    let url = format!(
        "{}/v1/agent/{}/task/register",
        base_url.trim_end_matches('/'),
        record.agent_runtime_id
    );
    let response = client()?
        .post(&url)
        .json(&json!({ "timestamp": timestamp, "signature": signature }))
        .send()
        .await
        .context("failed to register agent identity task")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("failed to read agent identity registration response")?;
    if !status.is_success() {
        anyhow::bail!(
            "agent identity task registration failed: HTTP {status} {}",
            bounded_error_body(&body)
        )
    }
    let response: RegisterTaskResponse = serde_json::from_str(&body)
        .context("failed to decode agent identity registration response")?;
    let task_id = match (response.task_id, response.encrypted_task_id) {
        (Some(task_id), _) if !task_id.trim().is_empty() => task_id,
        (_, Some(encrypted)) if !encrypted.trim().is_empty() => {
            decrypt_task_id(&record, &encrypted)?
        }
        _ => anyhow::bail!("agent identity registration response omitted its task id"),
    };
    Ok(Auth::AgentIdentity(AgentIdentityAuth { record, task_id }))
}

impl AgentIdentityAuth {
    fn authorization_header(&self) -> Result<String> {
        let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let signature = sign(
            &self.record,
            &format!(
                "{}:{}:{timestamp}",
                self.record.agent_runtime_id, self.task_id
            ),
        )?;
        let assertion = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&BTreeMap::from([
            ("agent_runtime_id", self.record.agent_runtime_id.as_str()),
            ("signature", signature.as_str()),
            ("task_id", self.task_id.as_str()),
            ("timestamp", timestamp.as_str()),
        ]))?);
        Ok(format!("AgentAssertion {assertion}"))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(u64::MAX)
        })
}

pub fn bearer_from_json(value: &Value) -> Result<Auth> {
    let credential = value
        .get("openai-codex")
        .context("Pi auth file has no openai-codex credential; run /login openai-codex")?;
    let access_token = credential
        .get("access")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .context("Pi openai-codex credential has no access token; run /login openai-codex")?;
    let account_id = credential
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| account_id_from_jwt(access_token))
        .context("Pi openai-codex credential has no account id; run /login openai-codex")?;
    Ok(Auth::Bearer {
        access_token: access_token.to_owned(),
        account_id,
    })
}

async fn refresh_bearer(path: &Path, value: &mut Value) -> Result<()> {
    let refresh_token = value
        .get("openai-codex")
        .and_then(|credential| credential.get("refresh"))
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .context(
            "Pi access token is expired and no refresh token is available; run /login openai-codex",
        )?;
    let response = client()?
        .post("https://auth.openai.com/oauth/token")
        .json(&json!({
            "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .context("failed to refresh Pi openai-codex token")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("failed to read token refresh response")?;
    if !status.is_success() {
        anyhow::bail!(
            "Pi openai-codex token refresh failed: HTTP {status} {}",
            bounded_error_body(&body)
        )
    }
    let refreshed: Value =
        serde_json::from_str(&body).context("failed to decode token refresh response")?;
    let access_token = refreshed
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .context("token refresh response has no access_token")?;
    let entry = value
        .get_mut("openai-codex")
        .and_then(Value::as_object_mut)
        .context("Pi auth file has no openai-codex credential")?;
    entry.insert("access".to_owned(), Value::String(access_token.to_owned()));
    if let Some(refresh_token) = refreshed.get("refresh_token") {
        entry.insert("refresh".to_owned(), refresh_token.clone());
    }
    if let Some(expires_in) = refreshed.get("expires_in").and_then(Value::as_u64) {
        entry.insert(
            "expires".to_owned(),
            Value::Number((now_ms().saturating_add(expires_in.saturating_mul(1_000))).into()),
        );
    }
    if let Some(account_id) = refreshed
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(account_id_from_jwt)
    {
        entry.insert("accountId".to_owned(), Value::String(account_id));
    }
    fs::write(path, serde_json::to_vec_pretty(value)?).with_context(|| {
        format!(
            "failed to write refreshed Pi auth file `{}`",
            path.display()
        )
    })?;
    Ok(())
}

pub async fn read() -> Result<Auth> {
    match env::var("PI_CODEX_AGENT_IDENTITY_JWT") {
        Ok(jwt) if jwt.trim().is_empty() => {
            anyhow::bail!("PI_CODEX_AGENT_IDENTITY_JWT is set but empty")
        }
        Ok(jwt) => return load_agent_identity(&jwt).await,
        Err(env::VarError::NotPresent) => {}
        Err(error) => return Err(error).context("PI_CODEX_AGENT_IDENTITY_JWT is not valid UTF-8"),
    }
    match (
        env::var("PI_CODEX_ACCESS_TOKEN"),
        env::var("PI_CODEX_ACCOUNT_ID"),
    ) {
        (Ok(access_token), Ok(account_id))
            if !access_token.trim().is_empty() && !account_id.trim().is_empty() =>
        {
            return Ok(Auth::Bearer {
                access_token,
                account_id,
            });
        }
        (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => {}
        (Ok(_), Ok(_)) => {
            anyhow::bail!("PI_CODEX_ACCESS_TOKEN and PI_CODEX_ACCOUNT_ID must both be non-empty")
        }
        _ => anyhow::bail!(
            "PI_CODEX_ACCESS_TOKEN and PI_CODEX_ACCOUNT_ID must both be set or both be unset"
        ),
    }

    let path =
        env::var_os("PI_AUTH_PATH").map_or_else(|| pi_agent_dir().join("auth.json"), PathBuf::from);
    let contents = fs::read_to_string(&path)
        .with_context(|| format!("failed to read Pi auth file `{}`", path.display()))?;
    let mut value: Value = serde_json::from_str(&contents)
        .with_context(|| format!("failed to parse Pi auth file `{}`", path.display()))?;
    match value.get("agent_identity") {
        Some(Value::String(jwt)) if !jwt.trim().is_empty() => {
            return load_agent_identity(jwt).await;
        }
        Some(Value::String(_) | Value::Null) | None => {}
        Some(_) => anyhow::bail!("Pi auth field agent_identity must be a string or null"),
    }
    let expires = value
        .get("openai-codex")
        .and_then(|credential| credential.get("expires"))
        .and_then(Value::as_u64);
    if expires.is_some_and(|expires| expires <= now_ms().saturating_add(60_000)) {
        refresh_bearer(&path, &mut value).await?;
    }
    bearer_from_json(&value).with_context(|| format!("invalid Pi auth file `{}`", path.display()))
}
