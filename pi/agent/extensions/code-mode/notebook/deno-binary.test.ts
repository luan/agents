import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DENO_VERSION, denoAssetUrl, resolveDenoAsset } from "./deno-assets.ts";
import { denoBinaryPath, verifiedFile, verifyBytes } from "./deno-binary.ts";

const PLATFORMS: Array<[string, string, string]> = [
	["linux", "x64", "deno-x86_64-unknown-linux-gnu.zip"],
	["linux", "arm64", "deno-aarch64-unknown-linux-gnu.zip"],
	["darwin", "x64", "deno-x86_64-apple-darwin.zip"],
	["darwin", "arm64", "deno-aarch64-apple-darwin.zip"],
	["win32", "x64", "deno-x86_64-pc-windows-msvc.zip"],
	["win32", "arm64", "deno-aarch64-pc-windows-msvc.zip"],
];

it("resolves a pinned asset for every supported platform", () => {
	for (const [platform, arch, archive] of PLATFORMS) {
		const asset = resolveDenoAsset(platform, arch);
		expect(asset.archive).toBe(archive);
		expect(asset.executable).toBe(platform === "win32" ? "deno.exe" : "deno");
		expect(asset.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/);
		expect(asset.archiveBytes).toBeGreaterThan(0);
		expect(asset.binaryBytes).toBeGreaterThan(0);
	}
});

it("keeps the darwin-arm64 digests verified on this machine", () => {
	const asset = resolveDenoAsset("darwin", "arm64");
	expect(asset.archiveBytes).toBe(38_511_993);
	expect(asset.archiveSha256).toBe("b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615");
	expect(asset.binarySha256).toBe("b5bd08edab254d42d7b05aa5b6cb4c9b8d4dede4975aff76951ce2cce18866fa");
});

it("rejects an unsupported platform", () => {
	expect(() => resolveDenoAsset("sunos", "sparc")).toThrow("Notebook Code Mode does not support sunos-sparc");
});

it("builds the release download URL", () => {
	expect(denoAssetUrl("deno-aarch64-apple-darwin.zip")).toBe(
		`https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-aarch64-apple-darwin.zip`,
	);
});

it("caches under the agent directory by version and executable name", () => {
	expect(denoBinaryPath("/agent", "darwin", "arm64")).toBe(`/agent/notebook/deno/${DENO_VERSION}/deno`);
	expect(denoBinaryPath("/agent", "win32", "x64")).toBe(`/agent/notebook/deno/${DENO_VERSION}/deno.exe`);
});

it("names both values when a digest or a length does not match", () => {
	const bytes = Buffer.from("deno");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	expect(() => verifyBytes(bytes, sha256, bytes.length, "fixture")).not.toThrow();
	expect(() => verifyBytes(bytes, sha256, 99, "fixture")).toThrow("fixture is 4 bytes, expected 99");
	expect(() => verifyBytes(bytes, "0".repeat(64), bytes.length, "fixture")).toThrow(
		`fixture sha256 is ${sha256}, expected ${"0".repeat(64)}`,
	);
});

it("verifies a cached file by length and digest", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-deno-binary-"));
	const path = join(root, "deno");
	const bytes = Buffer.from("pinned deno bytes");
	writeFileSync(path, bytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	expect(verifiedFile(path, sha256, bytes.length)).toBe(true);
	expect(verifiedFile(path, sha256, bytes.length + 1)).toBe(false);
	expect(verifiedFile(path, "0".repeat(64), bytes.length)).toBe(false);
	expect(verifiedFile(join(root, "absent"), sha256, bytes.length)).toBe(false);
});
