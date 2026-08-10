import "./setup-home";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	checkPiExtensionRegistration,
	getPiSessionDir,
	getPiSettingsPath,
	readPiSettings,
	writePiSettings,
} from "./pi/index.js";
import { resolveContentStorePath } from "./session/paths.js";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

describe("Pi path/settings helpers", () => {
	it("derives a v2 content store path from a 16-hex project hash", () => {
		const dbPath = resolveContentStorePath({
			projectDir: "/test/project",
			contentDir: getPiSessionDir(),
		});
		expect(dbPath).toMatch(/[a-f0-9]{16}\.v2\.db$/);
		expect(dbPath).toContain(".pi");
	});

	it("readSettings returns null when file missing", () => {
		rmSync(getPiSettingsPath(), { force: true });
		expect(readPiSettings()).toBeNull();
	});

	it("writeSettings then readSettings round-trips", () => {
		writePiSettings({ foo: "bar" });
		expect(readPiSettings()).toEqual({ foo: "bar" });
	});

	it("reports missing extension registration with an agents-host hint", () => {
		process.env.PI_CODING_AGENT_DIR = join(homedir(), "missing-agent-dir");
		try {
			expect(checkPiExtensionRegistration()).toEqual({
				check: "Pi extension registration",
				status: "fail",
				message: expect.stringContaining("Pi agent settings not found"),
				fix: "Add extensions/context-guard/index.ts to pi/agent/settings.json or set PI_CODING_AGENT_DIR.",
			});
		} finally {
			if (originalPiCodingAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
			}
		}
	});
});
