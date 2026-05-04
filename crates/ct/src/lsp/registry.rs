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
        id: "astro",
        name: "astro",
        extensions: &["astro"],
        root_markers: &["package.json", "astro.config.mjs", "astro.config.ts"],
        commands: &["astro-ls"],
        args: &["--stdio"],
        language_id: "astro",
    },
    LspServerDefinition {
        id: "bash",
        name: "bash-language-server",
        extensions: &["sh", "bash", "zsh", "ksh"],
        root_markers: &[".bashrc", ".zshrc"],
        commands: &["bash-language-server"],
        args: &["start"],
        language_id: "shellscript",
    },
    LspServerDefinition {
        id: "clangd",
        name: "clangd",
        extensions: &[
            "c", "cpp", "cc", "cxx", "c++", "h", "hpp", "hh", "hxx", "h++",
        ],
        root_markers: &[
            "compile_commands.json",
            "compile_flags.txt",
            "CMakeLists.txt",
        ],
        commands: &["clangd"],
        args: &[],
        language_id: "cpp",
    },
    LspServerDefinition {
        id: "csharp",
        name: "csharp-ls",
        extensions: &["cs", "csx"],
        root_markers: &["*.sln", "*.csproj"],
        commands: &["csharp-ls", "omnisharp"],
        args: &[],
        language_id: "csharp",
    },
    LspServerDefinition {
        id: "clojure-lsp",
        name: "clojure-lsp",
        extensions: &["clj", "cljs", "cljc", "edn"],
        root_markers: &["deps.edn", "project.clj", "bb.edn"],
        commands: &["clojure-lsp"],
        args: &[],
        language_id: "clojure",
    },
    LspServerDefinition {
        id: "dart",
        name: "Dart Analysis Server",
        extensions: &["dart"],
        root_markers: &["pubspec.yaml"],
        commands: &["dart"],
        args: &["language-server", "--protocol=lsp"],
        language_id: "dart",
    },
    LspServerDefinition {
        id: "deno",
        name: "deno lsp",
        extensions: &["ts", "tsx", "js", "jsx", "mjs"],
        root_markers: &["deno.json", "deno.jsonc"],
        commands: &["deno"],
        args: &["lsp"],
        language_id: "typescript",
    },
    LspServerDefinition {
        id: "elixir-ls",
        name: "elixir-ls",
        extensions: &["ex", "exs"],
        root_markers: &["mix.exs"],
        commands: &["elixir-ls", "language_server.sh"],
        args: &[],
        language_id: "elixir",
    },
    LspServerDefinition {
        id: "eslint",
        name: "eslint",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue"],
        root_markers: &[
            "eslint.config.js",
            "eslint.config.mjs",
            "eslint.config.cjs",
            ".eslintrc",
            ".eslintrc.js",
            ".eslintrc.cjs",
            ".eslintrc.json",
        ],
        commands: &["vscode-eslint-language-server"],
        args: &["--stdio"],
        language_id: "typescript",
    },
    LspServerDefinition {
        id: "fsharp",
        name: "fsautocomplete",
        extensions: &["fs", "fsi", "fsx", "fsscript"],
        root_markers: &["*.sln", "*.fsproj"],
        commands: &["fsautocomplete"],
        args: &["--adaptive-lsp-server-enabled"],
        language_id: "fsharp",
    },
    LspServerDefinition {
        id: "gleam",
        name: "gleam",
        extensions: &["gleam"],
        root_markers: &["gleam.toml"],
        commands: &["gleam"],
        args: &["lsp"],
        language_id: "gleam",
    },
    LspServerDefinition {
        id: "gopls",
        name: "gopls",
        extensions: &["go"],
        root_markers: &["go.work", "go.mod", "go.sum"],
        commands: &["gopls"],
        args: &[],
        language_id: "go",
    },
    LspServerDefinition {
        id: "hls",
        name: "haskell-language-server",
        extensions: &["hs", "lhs"],
        root_markers: &["hie.yaml", "stack.yaml", "cabal.project", "package.yaml"],
        commands: &["haskell-language-server-wrapper"],
        args: &["--lsp"],
        language_id: "haskell",
    },
    LspServerDefinition {
        id: "jdtls",
        name: "jdtls",
        extensions: &["java"],
        root_markers: &["pom.xml", "build.gradle", "build.gradle.kts", ".project"],
        commands: &["jdtls"],
        args: &[],
        language_id: "java",
    },
    LspServerDefinition {
        id: "julials",
        name: "julia LanguageServer",
        extensions: &["jl"],
        root_markers: &["Project.toml", "Manifest.toml"],
        commands: &["julia"],
        args: &[
            "--startup-file=no",
            "--history-file=no",
            "-e",
            "using LanguageServer; runserver()",
        ],
        language_id: "julia",
    },
    LspServerDefinition {
        id: "kotlin-ls",
        name: "kotlin-ls",
        extensions: &["kt", "kts"],
        root_markers: &[
            "settings.gradle",
            "settings.gradle.kts",
            "build.gradle",
            "build.gradle.kts",
        ],
        commands: &["kotlin-ls", "kotlin-language-server"],
        args: &[],
        language_id: "kotlin",
    },
    LspServerDefinition {
        id: "lua-ls",
        name: "lua-language-server",
        extensions: &["lua"],
        root_markers: &[".luarc.json", ".luarc.jsonc", ".stylua.toml"],
        commands: &["lua-language-server"],
        args: &[],
        language_id: "lua",
    },
    LspServerDefinition {
        id: "nixd",
        name: "nixd",
        extensions: &["nix"],
        root_markers: &["flake.nix", "default.nix", "shell.nix"],
        commands: &["nixd"],
        args: &[],
        language_id: "nix",
    },
    LspServerDefinition {
        id: "ocaml-lsp",
        name: "ocamllsp",
        extensions: &["ml", "mli"],
        root_markers: &["dune-project", "dune", "*.opam"],
        commands: &["ocamllsp"],
        args: &[],
        language_id: "ocaml",
    },
    LspServerDefinition {
        id: "oxlint",
        name: "oxlint",
        extensions: &[
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "astro", "svelte",
        ],
        root_markers: &["package.json"],
        commands: &["oxc_language_server", "oxlint"],
        args: &[],
        language_id: "typescript",
    },
    LspServerDefinition {
        id: "php-intelephense",
        name: "php intelephense",
        extensions: &["php"],
        root_markers: &["composer.json", "index.php"],
        commands: &["intelephense"],
        args: &["--stdio"],
        language_id: "php",
    },
    LspServerDefinition {
        id: "prisma",
        name: "prisma",
        extensions: &["prisma"],
        root_markers: &["schema.prisma", "package.json"],
        commands: &["prisma-language-server"],
        args: &["--stdio"],
        language_id: "prisma",
    },
    LspServerDefinition {
        id: "pyright",
        name: "pyright",
        extensions: &["py", "pyi"],
        root_markers: &[
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
        ],
        commands: &["pyright-langserver"],
        args: &["--stdio"],
        language_id: "python",
    },
    LspServerDefinition {
        id: "razor",
        name: "razor",
        extensions: &["razor", "cshtml"],
        root_markers: &["*.sln", "*.csproj"],
        commands: &["razor-language-server"],
        args: &["--stdio"],
        language_id: "razor",
    },
    LspServerDefinition {
        id: "ruby-lsp",
        name: "ruby-lsp",
        extensions: &["rb", "rake", "gemspec", "ru"],
        root_markers: &["Gemfile", ".ruby-version", "*.gemspec"],
        commands: &["ruby-lsp"],
        args: &[],
        language_id: "ruby",
    },
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
        id: "sourcekit-lsp",
        name: "SourceKit-LSP",
        extensions: &["swift", "objc", "objcpp"],
        root_markers: &["Package.swift"],
        commands: &["sourcekit-lsp"],
        args: &[],
        language_id: "swift",
    },
    LspServerDefinition {
        id: "svelte",
        name: "svelte",
        extensions: &["svelte"],
        root_markers: &["package.json", "svelte.config.js", "svelte.config.ts"],
        commands: &["svelteserver", "svelte-language-server"],
        args: &["--stdio"],
        language_id: "svelte",
    },
    LspServerDefinition {
        id: "terraform",
        name: "terraform-ls",
        extensions: &["tf", "tfvars"],
        root_markers: &[".terraform", "main.tf"],
        commands: &["terraform-ls"],
        args: &["serve"],
        language_id: "terraform",
    },
    LspServerDefinition {
        id: "tinymist",
        name: "tinymist",
        extensions: &["typ", "typc"],
        root_markers: &["typst.toml"],
        commands: &["tinymist"],
        args: &[],
        language_id: "typst",
    },
    LspServerDefinition {
        id: "typescript",
        name: "typescript",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        root_markers: &[
            "package-lock.json",
            "bun.lockb",
            "bun.lock",
            "pnpm-lock.yaml",
            "yarn.lock",
            "package.json",
        ],
        commands: &["vtsls", "typescript-language-server"],
        args: &["--stdio"],
        language_id: "typescript",
    },
    LspServerDefinition {
        id: "vue",
        name: "vue",
        extensions: &["vue"],
        root_markers: &[
            "package.json",
            "vue.config.js",
            "vite.config.ts",
            "vite.config.js",
        ],
        commands: &["vue-language-server"],
        args: &["--stdio"],
        language_id: "vue",
    },
    LspServerDefinition {
        id: "yaml-ls",
        name: "yaml-language-server",
        extensions: &["yaml", "yml"],
        root_markers: &[".yamllint", "docker-compose.yml"],
        commands: &["yaml-language-server"],
        args: &["--stdio"],
        language_id: "yaml",
    },
    LspServerDefinition {
        id: "zls",
        name: "zls",
        extensions: &["zig", "zon"],
        root_markers: &["build.zig", "zls.json"],
        commands: &["zls"],
        args: &[],
        language_id: "zig",
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

pub fn probe_for_server_root(server: LspServerDefinition, root: &Path) -> LspServerProbe {
    let command = find_command(root, &server);
    LspServerProbe {
        available: command.is_some(),
        server,
        root: Some(root.to_path_buf()),
        command,
    }
}

fn find_command(root: &Path, server: &LspServerDefinition) -> Option<PathBuf> {
    for command in server.commands {
        let local = root.join("node_modules").join(".bin").join(command);
        if local.is_file() {
            return Some(local);
        }
        if let Some(path) = find_in_mason_bin(command) {
            return Some(path);
        }
        if let Some(path) = find_on_path(command) {
            return Some(path);
        }
    }
    None
}

fn find_in_mason_bin(command: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidate = home
        .join(".local")
        .join("share")
        .join("nvim")
        .join("mason")
        .join("bin")
        .join(command);
    candidate.is_file().then_some(candidate)
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

#[cfg(test)]
mod tests {
    use super::SERVERS;

    #[test]
    fn registry_covers_common_lsp_servers() {
        let ids = SERVERS.iter().map(|server| server.id).collect::<Vec<_>>();
        for expected in [
            "astro",
            "bash",
            "clangd",
            "csharp",
            "clojure-lsp",
            "dart",
            "deno",
            "elixir-ls",
            "eslint",
            "fsharp",
            "gleam",
            "gopls",
            "hls",
            "jdtls",
            "julials",
            "kotlin-ls",
            "lua-ls",
            "nixd",
            "ocaml-lsp",
            "oxlint",
            "php-intelephense",
            "prisma",
            "pyright",
            "razor",
            "ruby-lsp",
            "rust",
            "sourcekit-lsp",
            "svelte",
            "terraform",
            "tinymist",
            "typescript",
            "vue",
            "yaml-ls",
            "zls",
        ] {
            assert!(ids.contains(&expected), "missing {expected}");
        }
        let typescript = SERVERS
            .iter()
            .find(|server| server.id == "typescript")
            .expect("typescript server");
        assert!(typescript.commands.contains(&"vtsls"));
    }
}
