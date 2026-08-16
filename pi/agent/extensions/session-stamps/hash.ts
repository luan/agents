import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `~/.pi/agent` is a symlink to `pi/agent`; realpath reaches the repo, where node_modules sits.
const EXTENSION_ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const CORE_PACKAGE = "@earendil-works/pi-coding-agent";

export type BuildStamp = {
	/** sha256 over sorted (relative path, bytes) of every non-test .ts under pi/agent/extensions. */
	hash: string;
	files: number;
	bytes: number;
	/** pi-coding-agent version: hashing extension source cannot see the host. */
	core: string;
	ms: number;
};

function collectSources(dir: string, out: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectSources(full, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function coreVersion(): string {
	let dir = EXTENSION_ROOT;
	for (let up = 0; up < 6; up++) {
		const manifest = join(dir, "node_modules", CORE_PACKAGE, "package.json");
		if (existsSync(manifest)) {
			try {
				const version = JSON.parse(readFileSync(manifest, "utf-8")).version;
				if (typeof version === "string") return version;
			} catch {
				return "unknown";
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

/** Path is hashed with content, so a rename moves the hash; sorted so readdir order does not. */
export function computeBuildStamp(): BuildStamp {
	const started = performance.now();
	const digest = createHash("sha256");
	let bytes = 0;
	let files = 0;
	try {
		for (const file of collectSources(EXTENSION_ROOT, []).sort()) {
			const buf = readFileSync(file);
			digest.update(file.slice(EXTENSION_ROOT.length));
			digest.update(buf);
			bytes += buf.length;
			files += 1;
		}
	} catch {
		return { hash: "unreadable", files, bytes, core: coreVersion(), ms: +(performance.now() - started).toFixed(2) };
	}
	return {
		hash: digest.digest("hex").slice(0, 12),
		files,
		bytes,
		core: coreVersion(),
		ms: +(performance.now() - started).toFixed(2),
	};
}
