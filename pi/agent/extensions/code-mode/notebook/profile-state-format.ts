/**
 * Named profile schema, validation, and paths.
 *
 * A profile is a snapshot of top-level kernel bindings BY VALUE. It never stores cells and never
 * replays them, because replaying a cell would re-run its side effects.
 *
 * Storage is `${agentDir}/notebook/profiles/<name>/`, under the same root as the persistence layer.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const PROFILE_STATE_SCHEMA = 1;
export const MAX_PROFILE_ENTRIES = 10_000;
export const MAX_PROFILE_NAME_BYTES = 4 * 1024;
export const MAX_PROFILE_MANIFEST_BYTES = 8 * 1024 * 1024;

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PAYLOAD_NAME = /^profile-[0-9a-f-]+\.bin$/;
const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One captured binding. `offset`/`length` slice it out of the payload; `hash` proves the bytes. */
export interface NotebookProfileEntry {
	name: string;
	kind: "value" | "function";
	offset: number;
	length: number;
	hash: string;
}

export interface NotebookProfileSkipped {
	name: string;
	reason: string;
}

export interface ProfileStateManifest {
	schema: number;
	name: string;
	deno: string;
	v8: string;
	payload: string;
	createdAt: string;
	sourceProject: string;
	entries: NotebookProfileEntry[];
	skipped: NotebookProfileSkipped[];
}

export interface ProfileStateSummary {
	name: string;
	createdAt: string;
	sourceProject: string;
	values: number;
	definitions: number;
	skipped: number;
}

export function profileStatePaths(name: string, agentDir: string): { directory: string; manifest: string } {
	assertProfileName(name);
	const directory = join(profilesDirectory(agentDir), name);
	return { directory, manifest: join(directory, "profile.json") };
}

export function profilesDirectory(agentDir: string): string {
	return join(agentDir, "notebook", "profiles");
}

export function assertProfileName(name: string): void {
	if (!PROFILE_NAME.test(name)) {
		throw new Error(
			"Notebook profile name must be 1-64 letters, numbers, dots, underscores, or hyphens and start with a letter or number",
		);
	}
}

/** Rejects a manifest before any caller believes it. A rejected manifest reads as `undefined`. */
export function readProfileStateManifest(path: string, expectedName?: string): ProfileStateManifest | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_MANIFEST_BYTES) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(value) || value["schema"] !== PROFILE_STATE_SCHEMA) return undefined;
		if (
			typeof value["name"] !== "string" ||
			!PROFILE_NAME.test(value["name"]) ||
			typeof value["deno"] !== "string" ||
			typeof value["v8"] !== "string" ||
			typeof value["payload"] !== "string" ||
			typeof value["createdAt"] !== "string" ||
			typeof value["sourceProject"] !== "string" ||
			!Array.isArray(value["entries"]) ||
			!Array.isArray(value["skipped"]) ||
			value["entries"].length > MAX_PROFILE_ENTRIES ||
			value["skipped"].length > MAX_PROFILE_ENTRIES ||
			!PAYLOAD_NAME.test(value["payload"]) ||
			basename(value["payload"]) !== value["payload"]
		) {
			return undefined;
		}
		if (expectedName !== undefined && value["name"] !== expectedName) return undefined;
		const entries = value["entries"].map(parseEntry);
		const skipped = value["skipped"].map(parseSkipped);
		if (entries.some((entry) => !entry) || skipped.some((entry) => !entry)) return undefined;
		return {
			schema: PROFILE_STATE_SCHEMA,
			name: value["name"],
			deno: value["deno"],
			v8: value["v8"],
			payload: value["payload"],
			createdAt: value["createdAt"],
			sourceProject: value["sourceProject"],
			entries: entries as NotebookProfileEntry[],
			skipped: skipped as NotebookProfileSkipped[],
		};
	} catch {
		return undefined;
	}
}

/** Profile storage stays inside `agentDir` and crosses no symlink on the way in. */
export function assertSafeProfileDirectory(directory: string, agentDir: string): void {
	const root = resolve(agentDir);
	const target = resolve(directory);
	const suffix = relative(root, target);
	if (!suffix || suffix.startsWith("..") || suffix.includes("\0")) {
		throw new Error("Notebook profile path escaped agent storage");
	}
	let current = root;
	for (const part of suffix.split(/[\\/]+/)) {
		current = join(current, part);
		if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
			throw new Error(`Notebook profile storage cannot use symlinked path: ${current}`);
		}
	}
}

/**
 * Reads the payload only when every entry lines up with it: no duplicate name, contiguous offsets,
 * no overrun, and a matching sha256 per entry. One mismatch rejects the whole payload.
 */
export function readProfileStatePayload(
	manifest: ProfileStateManifest,
	path: string,
	maxBytes: number,
): Buffer | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
		const payload = readFileSync(path);
		const names = new Set<string>();
		let offset = 0;
		for (const entry of manifest.entries) {
			if (names.has(entry.name) || entry.offset !== offset || entry.offset + entry.length > payload.length) {
				return undefined;
			}
			names.add(entry.name);
			if (hashProfileBytes(payload.subarray(entry.offset, entry.offset + entry.length)) !== entry.hash) {
				return undefined;
			}
			offset += entry.length;
		}
		return offset === payload.length ? payload : undefined;
	} catch {
		return undefined;
	}
}

export function profileSummary(manifest: ProfileStateManifest): ProfileStateSummary {
	const values = manifest.entries.filter(({ kind }) => kind === "value").length;
	return {
		name: manifest.name,
		createdAt: manifest.createdAt,
		sourceProject: manifest.sourceProject,
		values,
		definitions: manifest.entries.length - values,
		skipped: manifest.skipped.length,
	};
}

export function hashProfileBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function parseEntry(value: unknown): NotebookProfileEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { name, kind, offset, length, hash } = value;
	return typeof name === "string" &&
		IDENTIFIER.test(name) &&
		Buffer.byteLength(name) <= MAX_PROFILE_NAME_BYTES &&
		(kind === "value" || kind === "function") &&
		Number.isSafeInteger(offset) &&
		(offset as number) >= 0 &&
		Number.isSafeInteger(length) &&
		(length as number) >= 0 &&
		typeof hash === "string" &&
		HASH.test(hash)
		? { name, kind, offset: offset as number, length: length as number, hash }
		: undefined;
}

function parseSkipped(value: unknown): NotebookProfileSkipped | undefined {
	return isRecord(value) &&
		typeof value["name"] === "string" &&
		Buffer.byteLength(value["name"]) <= MAX_PROFILE_NAME_BYTES &&
		typeof value["reason"] === "string"
		? { name: value["name"], reason: value["reason"] }
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
