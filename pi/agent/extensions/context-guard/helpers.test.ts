import "./setup-home";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	checkPiExtensionRegistration,
	getPiConfigDir,
	getPiSessionDir,
	getPiSettingsPath,
	PI_NAME,
	readPiSettings,
	writePiSettings,
} from "./pi/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "./session/paths.js";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

describe("Pi path/settings helpers", () => {
	describe("identity", () => {
		it("name is Pi", () => {
			expect(PI_NAME).toBe("Pi");
		});
	});

	describe("session storage isolation", () => {
		it("writes session dir under ~/.pi/", () => {
			const dir = getPiSessionDir();
			expect(dir).toContain(".pi");
		});
	});

	describe("config paths", () => {
		it("session dir is under ~/.pi/context-guard/sessions/", () => {
			expect(getPiSessionDir()).toBe(join(homedir(), ".pi", "context-guard", "sessions"));
		});

		it("session DB path contains project hash and lives under .pi", () => {
			const dbPath = resolveSessionDbPath({
				projectDir: "/test/project",
				sessionsDir: getPiSessionDir(),
			});
			expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
			expect(dbPath).toContain(".pi");
		});

		it("session events path contains project hash and lives under .pi", () => {
			const eventsPath = join(getPiSessionDir(), `${hashProjectDirCanonical("/test/project")}-events.md`);
			expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
			expect(eventsPath).toContain(".pi");
		});

		it("settings path is ~/.pi/settings.json", () => {
			expect(getPiSettingsPath()).toBe(resolve(homedir(), ".pi", "settings.json"));
		});

		it("config dir is ~/.pi", () => {
			expect(getPiConfigDir()).toBe(resolve(homedir(), ".pi"));
		});
	});

	describe("settings I/O", () => {
		it("readSettings returns null when file missing", () => {
			rmSync(getPiSettingsPath(), { force: true });
			expect(readPiSettings()).toBeNull();
		});

		it("writeSettings then readSettings round-trips", () => {
			writePiSettings({ foo: "bar" });
			expect(readPiSettings()).toEqual({ foo: "bar" });
		});
	});

	describe("diagnostics", () => {
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
});
