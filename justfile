set shell := ["sh", "-eu", "-c"]
set windows-shell := ["C:\\Program Files\\Git\\bin\\bash.exe", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME", env("USERPROFILE", ""))

default:
    @just --list

setup:
    @cargo build --locked --manifest-path "{{ repo }}/Cargo.toml" --release
    @bun install --cwd "{{ repo }}" --frozen-lockfile
    @cargo xtask harness setup --home "{{ home }}"
    @just home="{{ home }}" check

format:
    @bun run --cwd "{{ repo }}" format

format-check:
    @bun run --cwd "{{ repo }}" check:format

lint:
    @bun run --cwd "{{ repo }}" lint:pi

typecheck:
    @bun run --cwd "{{ repo }}" typecheck

test:
    @bun run --cwd "{{ repo }}" test

pi-test:
    @bun run --cwd "{{ repo }}" test:pi

pi-install-check package:
    @check_root="$(mktemp -d)"; \
    trap 'rm -rf "$check_root"' EXIT; \
    live_settings="{{ home }}/.pi/agent/settings.json"; \
    live_settings_target="$(readlink "$live_settings" 2>/dev/null || true)"; \
    live_settings_checksum="$(cksum "$live_settings" 2>/dev/null || true)"; \
    live_settings_kind=missing; \
    if test -L "$live_settings"; then live_settings_kind=symlink; elif test -e "$live_settings"; then live_settings_kind=file; fi; \
    live_settings_state="$live_settings_kind:$live_settings_target:$live_settings_checksum"; \
    package_path="$(cd "$(dirname "{{ package }}")" && pwd)/$(basename "{{ package }}")"; \
    package_tree="{{ repo }}/harnesses/pi/agent/packages"; \
    case "$package_path" in "$package_tree"/*) ;; *) echo "package must be under $package_tree" >&2; exit 1;; esac; \
    if test "$(dirname "$package_path")" != "$package_tree" || test ! -d "$package_path" || test ! -f "$package_path/package.json"; then echo "package must be a direct package directory with package.json under $package_tree" >&2; exit 1; fi; \
    package_name="$(basename "$package_path")"; \
    mkdir -p "$check_root/packages" "$check_root/unpacked"; \
    tar -C "$package_tree" --exclude='*/node_modules' --exclude='node_modules' -cf - . | tar -C "$check_root/packages" -xf -; \
    bun -e 'import { existsSync, readdirSync } from "node:fs"; import { resolve } from "node:path"; const tree=process.argv[1]; for(const directory of readdirSync(tree)){ const path=resolve(tree,directory,"package.json"); if(!existsSync(path)) continue; const manifest=await Bun.file(path).json(); let changed=false; for(const [name,specification] of Object.entries(manifest.dependencies ?? {})){ if(typeof specification !== "string" || !specification.startsWith("workspace:")) continue; if(!existsSync(resolve(tree,name,"package.json"))) throw new Error(`workspace dependency has no package directory: ${name}`); manifest.dependencies[name]=`file:../${name}`; changed=true; } if(changed) await Bun.write(path,`${JSON.stringify(manifest,null,2)}\n`); }' "$check_root/packages"; \
    cd "$check_root/packages/$package_name"; \
    npm install --ignore-scripts --package-lock=false --install-links --omit=dev --no-audit --no-fund; \
    npm pack --ignore-scripts --json --pack-destination "$check_root" > "$check_root/pack.json"; \
    archive="$(find "$check_root" -maxdepth 1 -name '*.tgz' -print -quit)"; \
    test -n "$archive"; \
    tar -xzf "$archive" -C "$check_root/unpacked"; \
    packaged="$check_root/unpacked/package"; \
    mkdir -p "$check_root/external"; \
    bun -e 'import { resolve } from "node:path"; const packaged=process.argv[1]; const destination=process.argv[2]; const manifest=await Bun.file(resolve(packaged,"package.json")).json(); const dependencies=Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([,specification])=>typeof specification === "string" && !specification.startsWith("file:") && !specification.startsWith("workspace:"))); await Bun.write(resolve(destination,"package.json"),`${JSON.stringify({private:true,dependencies},null,2)}\n`);' "$packaged" "$check_root/external"; \
    cd "$check_root/external"; \
    npm install --ignore-scripts --package-lock=false --omit=dev --no-audit --no-fund; \
    if test -d node_modules; then mkdir -p "$packaged/node_modules"; cp -R node_modules/. "$packaged/node_modules/"; fi; \
    expected="$(bun -e 'import { resolve } from "node:path"; const manifest=await Bun.file(resolve(process.argv[1],"package.json")).json(); console.log(manifest.pi?.extensions?.length ?? 0);' "$packaged")"; \
    if test "$expected" -eq 0; then \
        bun -e 'import { resolve } from "node:path"; import { pathToFileURL } from "node:url"; const root=process.argv[1]; const manifest=await Bun.file(resolve(root,"package.json")).json(); const targets=Object.values(manifest.exports ?? {}).filter((target)=>typeof target === "string"); if(targets.length === 0) throw new Error("library package has no public exports"); for(const target of targets) await import(pathToFileURL(resolve(root,target)).href); console.log(`Loaded ${targets.length} packaged library exports.`);' "$packaged"; \
    else \
        agent_dir="$check_root/agent"; \
        PI_CODING_AGENT_DIR="$agent_dir" pi install "$packaged"; \
        cd "{{ repo }}"; \
        bun -e 'import { resolve } from "node:path"; const root=process.argv[1]; const agentDir=process.argv[2]; const sdk=process.argv[3]; const { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions }=await import(sdk); const manifest=await Bun.file(resolve(root,"package.json")).json(); const bundled=new Set(manifest.bundledDependencies ?? manifest.bundleDependencies ?? []); for(const [name,specification] of Object.entries(manifest.dependencies ?? {})){ if(typeof specification === "string" && (specification.startsWith("file:") || specification.startsWith("workspace:")) && !bundled.has(name)) throw new Error(`local runtime dependency is not bundled: ${name}`); } const settingsManager=SettingsManager.create(root,agentDir,{projectTrusted:false}); const resources=await new DefaultPackageManager({cwd:root,agentDir,settingsManager}).resolve(); const paths=resources.extensions.filter(({enabled})=>enabled).map(({path})=>path); const expected=manifest.pi?.extensions?.length ?? 0; if(paths.length !== expected) throw new Error(`resolved ${paths.length}/${expected} packaged Pi extensions:\n${paths.join("\n")}`); const loaded=await discoverAndLoadExtensions(paths,root,agentDir); if(loaded.errors.length) throw new Error(loaded.errors.map(({path,error})=>`${path}: ${error}`).join("\n")); if(loaded.extensions.length !== expected) throw new Error(`loaded ${loaded.extensions.length}/${expected} packaged Pi extensions`); console.log(`Resolved and loaded ${expected} packaged Pi extensions.`);' "$packaged" "$agent_dir" "{{ repo }}/harnesses/pi/agent/packages/pi-libtui/node_modules/@earendil-works/pi-coding-agent/dist/index.js"; \
    fi; \
    current_settings_target="$(readlink "$live_settings" 2>/dev/null || true)"; \
    current_settings_checksum="$(cksum "$live_settings" 2>/dev/null || true)"; \
    current_settings_kind=missing; \
    if test -L "$live_settings"; then current_settings_kind=symlink; elif test -e "$live_settings"; then current_settings_kind=file; fi; \
    current_settings_state="$current_settings_kind:$current_settings_target:$current_settings_checksum"; \
    if test "$live_settings_state" != "$current_settings_state"; then echo "pi-install-check modified live settings: $live_settings" >&2; exit 1; fi

rust-fmt:
    @cargo fmt --all -- --check

rust-lint:
    @cargo clippy --locked --all-targets -- -D warnings

rust-test:
    @cargo nextest run --locked

_build:
    @cargo build --locked --release

_harness-check:
    @cargo xtask harness check --home "{{ home }}"

check: _build lint typecheck pi-test rust-fmt rust-lint rust-test _harness-check

unlink:
    @cargo xtask harness unlink --home "{{ home }}"
