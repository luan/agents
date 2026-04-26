use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct LspServerDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: &'static [&'static str],
    pub root_markers: &'static [&'static str],
    pub commands: &'static [&'static str],
    pub args: &'static [&'static str],
    pub language_id: &'static str,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LspServerProbe {
    pub server: LspServerDefinition,
    pub root: Option<PathBuf>,
    pub command: Option<PathBuf>,
    pub available: bool,
}

pub const SERVERS: &[LspServerDefinition] = &[
    LspServerDefinition {
        id: "rust",
        name: "rust-analyzer",
        extensions: &["rs"],
        root_markers: &["Cargo.toml", "Cargo.lock"],
        commands: &["rust-analyzer"],
        args: &[],
        language_id: "rust",
    },
    LspServerDefinition {
        id: "go",
        name: "gopls",
        extensions: &["go"],
        root_markers: &["go.work", "go.mod", "go.sum", ".git"],
        commands: &["gopls"],
        args: &[],
        language_id: "go",
    },
    LspServerDefinition {
        id: "typescript",
        name: "TypeScript Language Server",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        root_markers: &[
            "package-lock.json",
            "bun.lockb",
            "bun.lock",
            "pnpm-lock.yaml",
            "yarn.lock",
            "package.json",
        ],
        commands: &["typescript-language-server"],
        args: &["--stdio"],
        language_id: "typescript",
    },
    LspServerDefinition {
        id: "svelte",
        name: "Svelte Language Server",
        extensions: &["svelte"],
        root_markers: &[
            "package.json",
            "package-lock.json",
            "bun.lockb",
            "bun.lock",
            "pnpm-lock.yaml",
            "yarn.lock",
        ],
        commands: &["svelteserver", "svelte-language-server"],
        args: &["--stdio"],
        language_id: "svelte",
    },
    LspServerDefinition {
        id: "swift",
        name: "SourceKit-LSP",
        extensions: &["swift"],
        root_markers: &["Package.swift", ".git"],
        commands: &["sourcekit-lsp"],
        args: &[],
        language_id: "swift",
    },
];

pub fn server_for_file(path: &Path) -> Option<LspServerDefinition> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    SERVERS
        .iter()
        .find(|server| server.extensions.iter().any(|ext| *ext == extension))
        .cloned()
}

pub fn probe_for_file(path: &Path) -> Option<LspServerProbe> {
    let server = server_for_file(path)?;
    let root = crate::lsp::root::nearest_root(path, server.root_markers);
    let command = find_command(root.as_deref().unwrap_or_else(|| Path::new(".")), &server);
    Some(LspServerProbe {
        available: command.is_some(),
        server,
        root,
        command,
    })
}

fn find_command(root: &Path, server: &LspServerDefinition) -> Option<PathBuf> {
    for command in server.commands {
        let local = root.join("node_modules").join(".bin").join(command);
        if local.is_file() {
            return Some(local);
        }
        if let Some(path) = find_on_path(command) {
            return Some(path);
        }
    }
    None
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
