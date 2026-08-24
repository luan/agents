import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createCodexDiagnosticsController } from "../src/diagnostics/controller.ts";
import { codexDiagnosticsLogPath, createCodexDiagnosticsLog } from "../src/diagnostics/logger.ts";
import { createCodexDiagnosticsStatus } from "../src/diagnostics/status.ts";
import type { CodexDiagnosticsEvent, CodexDiagnosticsSink } from "../src/provider/types.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-codex-diagnostics-"));
	temporaryDirectories.push(path);
	return path;
}

function context(options: { provider?: string; sessionId?: string; cwd?: string } = {}): {
	ctx: ExtensionContext;
	statuses: Array<string | undefined>;
	notifications: Array<{ message: string; type: string | undefined }>;
} {
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const provider = options.provider ?? "openai-codex";
	const sessionId = options.sessionId ?? "session-1";
	const model = {
		provider,
		id: provider === "openai-codex" ? "gpt-5.6-sol" : "other-model",
		api: provider === "openai-codex" ? "openai-codex-responses" : "other-api",
		baseUrl: "https://example.test",
	};
	return {
		statuses,
		notifications,
		ctx: {
			hasUI: true,
			mode: "tui",
			cwd: options.cwd ?? "/work/project",
			model,
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setStatus: (_key: string, value: string | undefined) => statuses.push(value),
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => `/sessions/${sessionId}.jsonl`,
				getSessionName: () => "Diagnostics Test",
			},
		} as unknown as ExtensionContext,
	};
}

const requestEvent: CodexDiagnosticsEvent = {
	type: "request",
	lane: "compaction",
	transport: "websocket",
	attempt: 1,
	fullInputItems: 43,
	sentInputItems: 43,
	socketReused: false,
	continuation: "no_continuation",
	canonicalHistory: "validated",
	previousResponseId: false,
};

test("status shows transport, holds a cache miss, and restores only the newest status", async () => {
	const view = context();
	const status = await createCodexDiagnosticsStatus({
		mode: "status",
		ctx: view.ctx,
		agentDir: await temporaryDirectory(),
		missHoldMs: 5,
	});
	expect(stripTerminalSequences(view.statuses.at(-1) ?? "")).toBe("Codex Cache • waiting");
	status.record(requestEvent);
	expect(view.statuses.at(-1)).toContain("compaction • WS full (no continuation)");
	status.record({
		type: "usage",
		lane: "compaction",
		transport: "websocket",
		inputTokens: 10,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		outputTokens: 2,
	});
	expect(view.statuses.at(-1)).toContain("compaction • MISS • WS full");
	status.record({ type: "prewarm-ready", transport: "websocket", socketReused: true });
	expect(view.statuses.at(-1)).toContain("MISS");
	await Bun.sleep(10);
	expect(stripTerminalSequences(view.statuses.at(-1) ?? "")).toBe("Codex Cache • prewarm ready • WS reused");
	await status.shutdown();
	expect(view.statuses.at(-1)).toBeUndefined();
});

test("a theme failure does not reject diagnostics setup", async () => {
	const view = context();
	view.ctx.ui.theme.getFgAnsi = () => {
		throw new Error("theme unavailable");
	};
	const status = await createCodexDiagnosticsStatus({
		mode: "status",
		ctx: view.ctx,
		agentDir: await temporaryDirectory(),
	});
	expect(view.notifications).toEqual([{ message: "Codex cache status stopped: theme unavailable", type: "warning" }]);
	await status.shutdown();
});

test("a delayed status failure does not escape the cache-miss timer", async () => {
	const view = context();
	view.ctx.ui.setStatus = (_key, value) => {
		if (value?.includes("prewarm ready")) throw new Error("status unavailable");
		view.statuses.push(value);
	};
	const status = await createCodexDiagnosticsStatus({
		mode: "status",
		ctx: view.ctx,
		agentDir: await temporaryDirectory(),
		missHoldMs: 5,
	});
	status.record({
		type: "usage",
		lane: "response",
		transport: "websocket",
		inputTokens: 10,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		outputTokens: 2,
	});
	status.record({ type: "prewarm-ready", transport: "websocket", socketReused: true });
	await Bun.sleep(10);
	expect(view.notifications).toEqual([{ message: "Codex cache status stopped: status unavailable", type: "warning" }]);
	await status.shutdown();
});

test("status-and-log writes safe metadata, drains writes, and uses private modes", async () => {
	const agentDir = await temporaryDirectory();
	const view = context({ sessionId: "../../ session-secret" });
	const status = await createCodexDiagnosticsStatus({ mode: "status-and-log", ctx: view.ctx, agentDir });
	status.record(requestEvent);
	status.record({
		type: "failure",
		lane: "compaction",
		transport: "websocket",
		failure: { category: "authentication", code: "invalid_token", status: 401 },
	});
	await status.shutdown();

	const directory = join(agentDir, "logs", "codex-native");
	const files = Array.from(new Bun.Glob("*.log").scanSync(directory));
	expect(files).toHaveLength(1);
	const path = join(directory, files[0]!);
	const contents = await readFile(path, "utf8");
	expect(contents).toContain("Metadata only");
	expect(contents).toContain('event="request" lane="compaction" transport="websocket"');
	expect(contents).toContain('failure="authentication" code="invalid_token" status=401');
	expect(contents).not.toContain("Bearer secret");
	expect(contents).not.toContain("resp_secret");
	expect((await stat(directory)).mode & 0o777).toBe(0o700);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("status-and-log repairs permissive modes on existing paths", async () => {
	const agentDir = await temporaryDirectory();
	const view = context();
	const directory = join(agentDir, "logs", "codex-native");
	const path = codexDiagnosticsLogPath({
		agentDir,
		sessionId: view.ctx.sessionManager.getSessionId(),
		sessionFile: view.ctx.sessionManager.getSessionFile(),
		sessionName: view.ctx.sessionManager.getSessionName(),
	});
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o755);
	await writeFile(path, "existing\n", { mode: 0o644 });
	await chmod(path, 0o644);
	const status = await createCodexDiagnosticsStatus({ mode: "status-and-log", ctx: view.ctx, agentDir });
	await status.shutdown();
	expect((await stat(directory)).mode & 0o777).toBe(0o700);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("the log redacts credential-shaped values from metadata and its filename", async () => {
	const agentDir = await temporaryDirectory();
	const secrets = {
		sessionId: "sess-abcdefghijklmnop",
		sessionName: "Bearer private-session-token",
		sessionFile: "/sessions/sk-abcdefghijklmnop.jsonl",
		cwd: "/work/eyJabcdefghijklmnop",
		modelId: "sk-ponmlkjihgfedcba",
	};
	const log = await createCodexDiagnosticsLog({
		agentDir,
		...secrets,
		modelProvider: "openai-codex",
		onError: () => {},
	});
	await log.close();
	const contents = await readFile(log.path, "utf8");
	for (const secret of Object.values(secrets)) {
		expect(contents).not.toContain(secret);
		expect(log.path).not.toContain(secret);
	}
	expect(contents).toContain("[redacted]");
});

test("a log startup failure leaves status diagnostics active", async () => {
	const view = context();
	const status = await createCodexDiagnosticsStatus({
		mode: "status-and-log",
		ctx: view.ctx,
		agentDir: await temporaryDirectory(),
		createLog: async () => {
			throw new Error("disk unavailable");
		},
	});
	expect(view.notifications).toEqual([{ message: "Codex cache logging stopped: disk unavailable", type: "warning" }]);
	status.record(requestEvent);
	expect(view.statuses.at(-1)).toContain("compaction • WS full");
	await status.shutdown();
});

test("a log write failure reports once and leaves status diagnostics active", async () => {
	const view = context();
	const status = await createCodexDiagnosticsStatus({
		mode: "status-and-log",
		ctx: view.ctx,
		agentDir: await temporaryDirectory(),
		createLog: async (options) => ({
			path: "/tmp/test.log",
			record() {
				options.onError(new Error("write failed"));
				options.onError(new Error("write failed again"));
			},
			async close() {},
		}),
	});
	status.record(requestEvent);
	expect(view.notifications).toEqual([{ message: "Codex cache logging stopped: write failed", type: "warning" }]);
	expect(view.statuses.at(-1)).toContain("compaction • WS full");
	expect(view.statuses.at(-1)).not.toContain("log");
	await status.shutdown();
});

test("controller follows model and session lifecycle through the provider subscription", async () => {
	let listener: CodexDiagnosticsSink | undefined;
	let unsubscribed = false;
	const provider = {
		registerDiagnostics(next: CodexDiagnosticsSink) {
			listener = next;
			return () => {
				unsubscribed = true;
				listener = undefined;
			};
		},
	};
	const controller = createCodexDiagnosticsController(provider, {
		agentDir: await temporaryDirectory(),
		getSettings: () => ({
			...DEFAULT_CODEX_NATIVE_SETTINGS,
			cacheDiagnostics: "status",
		}),
	});
	const codex = context();
	await controller.configure(codex.ctx);
	expect(stripTerminalSequences(codex.statuses.at(-1) ?? "")).toBe("Codex Cache • waiting");
	listener?.(requestEvent);
	expect(codex.statuses.at(-1)).toContain("compaction • WS full");

	const other = context({ provider: "anthropic", sessionId: "session-1" });
	await controller.configure(other.ctx);
	expect(codex.statuses.at(-1)).toBeUndefined();
	listener?.(requestEvent);
	expect(other.statuses).toEqual([]);

	await controller.configure(codex.ctx);
	expect(stripTerminalSequences(codex.statuses.at(-1) ?? "")).toBe("Codex Cache • waiting");
	await controller.shutdown();
	expect(codex.statuses.at(-1)).toBeUndefined();
	expect(unsubscribed).toBe(true);
});
