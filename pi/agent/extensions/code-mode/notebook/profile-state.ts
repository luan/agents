/**
 * Named profile snapshot I/O.
 *
 * This module moves bytes only. The kernel capture and restore live behind the lifecycle host, so
 * a profile is written and read BY VALUE and no cell is ever replayed.
 *
 * There is no lock. The payload is written under a unique name and the manifest lands by atomic
 * rename, so two concurrent saves of one name settle on one manifest with its own payload.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	assertSafeProfileDirectory,
	hashProfileBytes,
	MAX_PROFILE_ENTRIES,
	MAX_PROFILE_MANIFEST_BYTES,
	MAX_PROFILE_NAME_BYTES,
	type NotebookProfileEntry,
	type NotebookProfileSkipped,
	PROFILE_STATE_SCHEMA,
	type ProfileStateManifest,
	type ProfileStateSummary,
	profileStatePaths,
	profileSummary,
	profilesDirectory,
	readProfileStateManifest,
	readProfileStatePayload,
} from "./profile-state-format.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** What the kernel handed back. `entries` slice `payload`; hashes are computed here, not there. */
export interface NotebookProfileCapture {
	deno: string;
	v8: string;
	entries: Array<Omit<NotebookProfileEntry, "hash">>;
	skipped: NotebookProfileSkipped[];
	payload: Buffer;
}

export interface NotebookProfileSnapshot {
	manifest: ProfileStateManifest;
	payloadPath: string;
	payload: Buffer;
}

export function writeNotebookProfile(options: {
	name: string;
	agentDir: string;
	sourceProject: string;
	capture: NotebookProfileCapture;
}): ProfileStateSummary {
	const paths = profileStatePaths(options.name, options.agentDir);
	assertSafeProfileDirectory(paths.directory, options.agentDir);
	const entries = validatedEntries(options.capture);
	mkdirSync(paths.directory, { recursive: true });
	const manifest: ProfileStateManifest = {
		schema: PROFILE_STATE_SCHEMA,
		name: options.name,
		deno: options.capture.deno,
		v8: options.capture.v8,
		payload: `profile-${randomUUID()}.bin`,
		createdAt: new Date().toISOString(),
		sourceProject: resolve(options.sourceProject),
		entries,
		skipped: options.capture.skipped,
	};
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	if (Buffer.byteLength(text) > MAX_PROFILE_MANIFEST_BYTES) {
		throw new Error(`Notebook profile manifest exceeds ${MAX_PROFILE_MANIFEST_BYTES} bytes`);
	}
	const previous = readProfileStateManifest(paths.manifest, options.name);
	writeFileSync(join(paths.directory, manifest.payload), options.capture.payload, { mode: 0o600 });
	const temporary = `${paths.manifest}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, paths.manifest);
	} finally {
		rmSync(temporary, { force: true });
	}
	if (previous && previous.payload !== manifest.payload)
		rmSync(join(paths.directory, previous.payload), { force: true });
	return profileSummary(manifest);
}

/** Reads a profile only when its manifest and its payload both validate. */
export function readNotebookProfile(name: string, agentDir: string, maxBytes: number): NotebookProfileSnapshot {
	const paths = profileStatePaths(name, agentDir);
	assertSafeProfileDirectory(paths.directory, agentDir);
	const manifest = readProfileStateManifest(paths.manifest, name);
	if (!manifest) throw new Error(`Notebook profile not found or invalid: ${name}`);
	const payloadPath = join(paths.directory, manifest.payload);
	const payload = readProfileStatePayload(manifest, payloadPath, maxBytes);
	if (!payload) throw new Error(`Notebook profile payload is missing or invalid: ${name}`);
	return { manifest, payloadPath, payload };
}

export function listNotebookProfiles(agentDir: string): ProfileStateSummary[] {
	let names: string[];
	try {
		names = readdirSync(profilesDirectory(agentDir));
	} catch {
		return [];
	}
	return names
		.flatMap((name) => {
			try {
				const paths = profileStatePaths(name, agentDir);
				assertSafeProfileDirectory(paths.directory, agentDir);
				const manifest = readProfileStateManifest(paths.manifest, name);
				return manifest ? [profileSummary(manifest)] : [];
			} catch {
				return [];
			}
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

/** Names a configured profile contributes to the kernel. Diagnostics uses them as known bindings. */
export function notebookProfileBindingNames(name: string | undefined, agentDir: string, maxBytes: number): string[] {
	if (!name) return [];
	try {
		return readNotebookProfile(name, agentDir, maxBytes).manifest.entries.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** The kernel is the source of `entries`. A gap, an overrun, or a bad name rejects the save. */
function validatedEntries(capture: NotebookProfileCapture): NotebookProfileEntry[] {
	assertCaptureBounds(capture);
	let offset = 0;
	const names = new Set<string>();
	const entries = capture.entries.map((entry) => {
		if (!IDENTIFIER.test(entry.name)) throw new Error(`Notebook profile rejects binding name: ${entry.name}`);
		if (names.has(entry.name)) throw new Error(`Notebook profile captured ${entry.name} twice`);
		names.add(entry.name);
		if (entry.offset !== offset || entry.length < 0 || entry.offset + entry.length > capture.payload.length) {
			throw new Error(`Notebook profile capture is not contiguous at ${entry.name}`);
		}
		offset += entry.length;
		return { ...entry, hash: hashProfileBytes(capture.payload.subarray(entry.offset, entry.offset + entry.length)) };
	});
	// readProfileStatePayload rejects trailing bytes, so a save that leaves any would never load.
	if (offset !== capture.payload.length) throw new Error("Notebook profile capture left unclaimed payload bytes");
	return entries;
}

function assertCaptureBounds(capture: NotebookProfileCapture): void {
	if (capture.entries.length > MAX_PROFILE_ENTRIES) {
		throw new Error(`Notebook profile exceeds ${MAX_PROFILE_ENTRIES} top-level values`);
	}
	const oversized = capture.entries.find((entry) => Buffer.byteLength(entry.name) > MAX_PROFILE_NAME_BYTES);
	if (oversized) throw new Error(`Notebook profile name exceeds ${MAX_PROFILE_NAME_BYTES} bytes`);
}

export class NotebookProfileRestoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NotebookProfileRestoreError";
	}
}
