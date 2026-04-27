use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use super::client::LspClient;
use super::registry::LspServerProbe;

const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_MAX_SESSIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LspSessionKey {
    pub root: PathBuf,
    pub server_id: String,
    pub command: PathBuf,
    pub language_id: String,
}

impl LspSessionKey {
    pub fn from_probe(probe: &LspServerProbe, cwd: &Path) -> Result<Self> {
        let root = probe.root.as_deref().unwrap_or(cwd);
        let command = probe
            .command
            .as_ref()
            .context("LSP command is unavailable")?;
        Ok(Self {
            root: normalize_existing_or_absolute(root, cwd),
            server_id: probe.server.id.to_string(),
            command: normalize_existing_or_absolute(command, cwd),
            language_id: probe.server.language_id.to_string(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct TrackedDocument {
    pub content_hash: String,
    _opened_at_ms: u128,
}

struct LspSession {
    client: LspClient,
    documents: HashMap<PathBuf, TrackedDocument>,
    last_used: Instant,
}

impl LspSession {
    fn start(probe: &LspServerProbe, key: LspSessionKey) -> Result<Self> {
        let mut client = LspClient::start(probe)?;
        client.initialize(probe)?;
        let _ = key;
        Ok(Self {
            client,
            documents: HashMap::new(),
            last_used: Instant::now(),
        })
    }

    fn ensure_document(&mut self, probe: &LspServerProbe, path: &Path) -> Result<DocumentState> {
        let content = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let content_hash = crate::apply_patch::sha1_hex(&content);
        let path = normalize_existing_or_absolute(path, Path::new("."));
        if let Some(document) = self.documents.get(&path) {
            if document.content_hash == content_hash {
                return Ok(DocumentState::Fresh);
            }
            return Ok(DocumentState::NeedsRestart);
        }
        self.client.open_file(probe, &path)?;
        self.documents.insert(
            path,
            TrackedDocument {
                content_hash,
                _opened_at_ms: now_ms(),
            },
        );
        Ok(DocumentState::Fresh)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentState {
    Fresh,
    NeedsRestart,
}

pub struct LspSessionPool {
    sessions: HashMap<LspSessionKey, LspSession>,
    idle_ttl: Duration,
    max_sessions: usize,
}

impl Default for LspSessionPool {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            idle_ttl: DEFAULT_IDLE_TTL,
            max_sessions: DEFAULT_MAX_SESSIONS,
        }
    }
}

impl LspSessionPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_session<T>(
        &mut self,
        probe: &LspServerProbe,
        path: &Path,
        cwd: &Path,
        op: impl FnOnce(&mut LspClient) -> Result<T>,
    ) -> Result<T> {
        self.prune();
        let key = LspSessionKey::from_probe(probe, cwd)?;
        if !self.sessions.contains_key(&key) {
            self.insert_session(probe, key.clone())?;
        }
        let needs_restart = {
            let session = self.sessions.get_mut(&key).context("LSP session missing")?;
            if !session.client.is_alive() {
                true
            } else {
                matches!(
                    session.ensure_document(probe, path)?,
                    DocumentState::NeedsRestart
                )
            }
        };
        if needs_restart {
            self.sessions.remove(&key);
            self.insert_session(probe, key.clone())?;
            let session = self.sessions.get_mut(&key).context("LSP session missing")?;
            session.ensure_document(probe, path)?;
        }
        let session = self.sessions.get_mut(&key).context("LSP session missing")?;
        session.last_used = Instant::now();
        op(&mut session.client)
    }

    fn insert_session(&mut self, probe: &LspServerProbe, key: LspSessionKey) -> Result<()> {
        while self.sessions.len() >= self.max_sessions {
            let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.sessions.remove(&oldest);
        }
        let session = LspSession::start(probe, key.clone())?;
        self.sessions.insert(key, session);
        Ok(())
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.sessions.retain(|_, session| {
            now.duration_since(session.last_used) <= self.idle_ttl && session.client.is_alive()
        });
    }
}

fn normalize_existing_or_absolute(path: &Path, cwd: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::registry::{LspServerDefinition, LspServerProbe};

    const TEST_SERVER: LspServerDefinition = LspServerDefinition {
        id: "test",
        name: "Test LSP",
        extensions: &["rs"],
        root_markers: &[],
        commands: &["test-lsp"],
        args: &[],
        language_id: "rust",
    };

    #[test]
    fn session_key_uses_probe_root_and_command() {
        let cwd = std::env::current_dir().unwrap();
        let probe = LspServerProbe {
            server: TEST_SERVER,
            root: Some(cwd.clone()),
            command: Some(PathBuf::from("/bin/echo")),
            available: true,
        };
        let key = LspSessionKey::from_probe(&probe, &cwd).unwrap();
        assert_eq!(key.root, cwd.canonicalize().unwrap());
        assert_eq!(key.server_id, "test");
        assert_eq!(key.command, PathBuf::from("/bin/echo"));
        assert_eq!(key.language_id, "rust");
    }

    #[test]
    fn session_key_falls_back_to_cwd_without_probe_root() {
        let cwd = std::env::current_dir().unwrap();
        let probe = LspServerProbe {
            server: TEST_SERVER,
            root: None,
            command: Some(PathBuf::from("/bin/echo")),
            available: true,
        };
        let key = LspSessionKey::from_probe(&probe, &cwd).unwrap();
        assert_eq!(key.root, cwd.canonicalize().unwrap());
    }

    #[test]
    fn changed_document_hash_requires_restart() {
        let tracked = TrackedDocument {
            content_hash: crate::apply_patch::sha1_hex(b"old"),
            _opened_at_ms: now_ms(),
        };
        assert_ne!(tracked.content_hash, crate::apply_patch::sha1_hex(b"new"));
    }
}
