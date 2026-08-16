/**
 * Deno acquisition for notebook code mode.
 *
 * The kernel is `deno jupyter --kernel`, so a pinned Deno 2.9.5 must exist on disk before the first
 * cell runs. `just notebook-prewarm` pays the ~40 MB download at setup time.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { DENO_VERSION, type DenoAsset, denoAssetUrl, resolveDenoAsset } from "./deno-assets.ts";

/** Absolute path of the cached executable, whether or not it exists yet. */
export function denoBinaryPath(agentDir = getAgentDir(), platform = process.platform, arch = process.arch): string {
	return join(agentDir, "notebook", "deno", DENO_VERSION, resolveDenoAsset(platform, arch).executable);
}

/** Throws when `bytes` does not match the pinned length and digest. The message names both values. */
export function verifyBytes(bytes: Buffer, expectedSha256: string, expectedBytes: number, label: string): void {
	if (bytes.length !== expectedBytes) {
		throw new Error(`${label} is ${bytes.length} bytes, expected ${expectedBytes}`);
	}
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expectedSha256) {
		throw new Error(`${label} sha256 is ${actual}, expected ${expectedSha256}`);
	}
}

/** True when the file exists and matches the pinned length and digest. */
export function verifiedFile(path: string, expectedSha256: string, expectedBytes: number): boolean {
	try {
		verifyBytes(readFileSync(path), expectedSha256, expectedBytes, path);
		return true;
	} catch {
		return false;
	}
}

let pending: Promise<string> | undefined;

/**
 * Returns the absolute path of a verified Deno 2.9.5. Downloads and extracts it once if needed.
 *
 * Concurrent callers share one in-flight promise, so the archive is fetched once per process.
 */
export function ensureDenoBinary(signal?: AbortSignal): Promise<string> {
	pending ??= acquire(signal).catch((error: unknown) => {
		pending = undefined;
		throw error;
	});
	return pending;
}

async function acquire(signal?: AbortSignal): Promise<string> {
	const asset = resolveDenoAsset(process.platform, process.arch);
	const destination = denoBinaryPath();
	if (verifiedFile(destination, asset.binarySha256, asset.binaryBytes)) return destination;
	rmSync(destination, { force: true });
	await install(destination, asset, signal);
	return destination;
}

async function install(destination: string, asset: DenoAsset, signal?: AbortSignal): Promise<void> {
	const directory = dirname(destination);
	mkdirSync(directory, { recursive: true });
	// A killed download must not leave a half file that a later existence check accepts, so
	// everything lands in a staging directory and only the verified binary is renamed into place.
	const staging = mkdtempSync(join(directory, ".staging-"));
	try {
		const url = denoAssetUrl(asset.archive);
		const response = await fetch(url, { redirect: "follow", signal });
		if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
		const archive = Buffer.from(await response.arrayBuffer());
		verifyBytes(archive, asset.archiveSha256, asset.archiveBytes, asset.archive);
		const archivePath = join(staging, asset.archive);
		writeFileSync(archivePath, archive);
		extract(archivePath, staging, asset.executable);
		const staged = join(staging, asset.executable);
		verifyBytes(readFileSync(staged), asset.binarySha256, asset.binaryBytes, asset.executable);
		if (process.platform !== "win32") chmodSync(staged, 0o755);
		renameSync(staged, destination);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Bun exposes no unzip API. `unzip` ships with macOS and every Linux distribution we run on, and
 * `Expand-Archive` ships with Windows PowerShell, so a shell-out beats writing a deflate reader.
 */
function extract(archivePath: string, into: string, executable: string): void {
	const result =
		process.platform === "win32"
			? spawnSync("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${into}'`,
				])
			: spawnSync("unzip", ["-o", "-q", archivePath, executable, "-d", into]);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`extracting ${executable} failed with status ${result.status}: ${result.stderr?.toString().trim()}`,
		);
	}
	if (!existsSync(join(into, executable))) throw new Error(`${archivePath} does not contain ${executable}`);
}

// `just notebook-prewarm` and `just doctor` run this file directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const asset = resolveDenoAsset(process.platform, process.arch);
	const path = denoBinaryPath();
	if (process.argv.includes("--check")) {
		const state = verifiedFile(path, asset.binarySha256, asset.binaryBytes)
			? "verified"
			: "missing (run just notebook-prewarm)";
		process.stdout.write(`deno ${DENO_VERSION}: ${state} at ${path}\n`);
	} else {
		process.stdout.write(`${await ensureDenoBinary()}\n`);
	}
}
