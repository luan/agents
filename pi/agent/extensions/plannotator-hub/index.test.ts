import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	applyPlannotatorHubEnvironment,
	setPlannotatorHubSettingsReaderForTests,
	syncPlannotatorHubSessionContext,
} from "./index";

const require = createRequire(import.meta.url);
const shared = require("./shared.cjs") as {
	buildPublicSessionUrl: (publicBase: string, sessionId: string) => string;
	describePlanPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
	describeReviewPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
	rewriteHtmlForSession: (html: string, sessionId: string) => string;
	validateBackendUrl: (url: string, hubPort?: number) => { ok: boolean; url?: string };
};
const hubServer = require("./hub-server.cjs") as {
	createState: () => {
		sessions: Map<string, { backendUrl: string }>;
		sessionIdsByBackend: Map<string, string>;
	};
	isBackendAlive: (entry: { backendUrl: string }) => Promise<boolean>;
	pruneDeadSessions: (state: {
		sessions: Map<string, { backendUrl: string }>;
		sessionIdsByBackend: Map<string, string>;
	}) => Promise<void>;
	removeSession: (
		state: {
			sessions: Map<string, { backendUrl: string }>;
			sessionIdsByBackend: Map<string, string>;
		},
		sessionId: string,
	) => boolean;
	tryText: (
		res: {
			headersSent?: boolean;
			writableEnded?: boolean;
			destroyed?: boolean;
			destroy?: (error?: Error) => void;
			writeHead?: (...args: unknown[]) => void;
			end?: (...args: unknown[]) => void;
		},
		status: number,
		body: string,
		headers?: Record<string, string>,
		error?: Error,
	) => boolean;
};

describe("plannotator hub environment", () => {
	test("forces upstream Plannotator onto random local ports and installs the browser shim", () => {
		const env: NodeJS.ProcessEnv = {
			PLANNOTATOR_PORT: "19432",
			PLANNOTATOR_BROWSER: "/usr/bin/firefox",
		};

		applyPlannotatorHubEnvironment({ env });

		expect(env.PLANNOTATOR_REMOTE).toBe("false");
		expect(env.PLANNOTATOR_PORT).toBeUndefined();
		expect(env.PLANNOTATOR_HUB_PORT).toBe("19432");
		expect(env.PLANNOTATOR_HUB_SCRIPT).toContain("hub-server.cjs");
		const shimEnvKey = process.platform === "darwin" ? "BROWSER" : "PLANNOTATOR_BROWSER";
		expect(env[shimEnvKey]).toContain("browser-shim.cjs");
		expect(env.PLANNOTATOR_HUB_OPEN_BROWSER).toBe("/usr/bin/firefox");
	});

	test("keeps the public URL when explicitly configured", () => {
		const env: NodeJS.ProcessEnv = {
			PLANNOTATOR_HUB_PUBLIC_URL: "https://plannotator.noxcraft.dev",
		};

		applyPlannotatorHubEnvironment({ env });

		expect(env.PLANNOTATOR_HUB_PUBLIC_URL).toBe("https://plannotator.noxcraft.dev");
	});

	test("settings override stale env values", () => {
		const restore = setPlannotatorHubSettingsReaderForTests(() => ({
			enabled: true,
			publicUrl: "https://plannotator.noxcraft.dev",
			port: "19432",
			bind: "127.0.0.1",
		}));
		const env: NodeJS.ProcessEnv = {
			PLANNOTATOR_HUB_PUBLIC_URL: "http://127.0.0.1:19432",
			PLANNOTATOR_HUB_PORT: "9999",
			PLANNOTATOR_HUB_BIND: "0.0.0.0",
		};

		try {
			applyPlannotatorHubEnvironment({ env, cwd: "/repo" });
		} finally {
			restore();
		}

		expect(env.PLANNOTATOR_HUB_PUBLIC_URL).toBe("https://plannotator.noxcraft.dev");
		expect(env.PLANNOTATOR_HUB_PORT).toBe("19432");
		expect(env.PLANNOTATOR_HUB_BIND).toBe("127.0.0.1");
	});

	test("settings can disable the hub wiring", () => {
		const restore = setPlannotatorHubSettingsReaderForTests(() => ({
			enabled: false,
		}));
		const env: NodeJS.ProcessEnv = {};

		try {
			applyPlannotatorHubEnvironment({ env, cwd: "/repo" });
		} finally {
			restore();
		}

		expect(env.PLANNOTATOR_HUB_PUBLIC_URL).toBeUndefined();
		expect(env.PLANNOTATOR_BROWSER).toBeUndefined();
	});

	test("copies session metadata into environment variables", () => {
		const env: NodeJS.ProcessEnv = {};
		syncPlannotatorHubSessionContext(
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s-123",
					getSessionFile: () => "/tmp/pi.jsonl",
					getSessionName: () => "feature lane",
				},
			} as any,
			env,
		);

		expect(env.PLANNOTATOR_HUB_SESSION_ID).toBe("s-123");
		expect(env.PLANNOTATOR_HUB_SESSION_FILE).toBe("/tmp/pi.jsonl");
		expect(env.PLANNOTATOR_HUB_SESSION_NAME).toBe("feature lane");
		expect(env.PLANNOTATOR_HUB_SESSION_CWD).toBe("/repo");
	});
});

describe("plannotator hub helpers", () => {
	test("rejects non-loopback backend URLs", () => {
		expect(shared.validateBackendUrl("https://example.com:1234")).toEqual({
			ok: false,
			reason: "backend URL must use http",
		});
		expect(shared.validateBackendUrl("http://10.0.0.8:1234")).toEqual({
			ok: false,
			reason: "backend URL must point at localhost",
		});
		expect(shared.validateBackendUrl("http://127.0.0.1:19432", 19432)).toEqual({
			ok: false,
			reason: "backend URL points at the hub port",
		});
	});

	test("rewrites absolute backend API paths under a session prefix", () => {
		const rewritten = shared.rewriteHtmlForSession(
			`<script>fetch("/api/plan"); const icon = '/favicon.svg';</script>`,
			"abc123",
		);
		expect(rewritten).toContain(`/s/abc123/api/plan`);
		expect(rewritten).toContain(`/s/abc123/favicon.svg`);
	});

	test("builds a public session URL under the configured base path", () => {
		expect(shared.buildPublicSessionUrl("https://plannotator.noxcraft.dev/base/", "abc123")).toBe(
			"https://plannotator.noxcraft.dev/base/s/abc123/",
		);
	});

	test("extracts plan and review labels for the picker UI", () => {
		expect(
			shared.describePlanPayload({
				mode: "annotate",
				filePath: "/repo/docs/plan.md",
				plan: "# Hidden title",
			}),
		).toMatchObject({
			kind: "annotate",
			title: "plan.md",
		});

		expect(
			shared.describeReviewPayload({
				gitRef: "branch vs main",
			}),
		).toMatchObject({
			kind: "review",
			title: "branch vs main",
		});
	});

	test("removes dead sessions from the registry", async () => {
		const state = hubServer.createState();
		state.sessions.set("closed", {
			backendUrl: "http://127.0.0.1:9",
		});
		state.sessionIdsByBackend.set("http://127.0.0.1:9", "closed");

		await hubServer.pruneDeadSessions(state);

		expect(state.sessions.has("closed")).toBe(false);
		expect(state.sessionIdsByBackend.has("http://127.0.0.1:9")).toBe(false);
	});

	test("removes live registry entries consistently", () => {
		const state = hubServer.createState();
		state.sessions.set("session-a", {
			backendUrl: "http://127.0.0.1:3001",
		});
		state.sessionIdsByBackend.set("http://127.0.0.1:3001", "session-a");

		expect(hubServer.removeSession(state, "session-a")).toBe(true);
		expect(state.sessions.size).toBe(0);
		expect(state.sessionIdsByBackend.size).toBe(0);
	});

	test("closes an already-started response instead of writing headers again", () => {
		const error = new Error("socket hang up");
		const calls: string[] = [];
		const res = {
			headersSent: true,
			writableEnded: false,
			destroyed: false,
			writeHead: () => calls.push("writeHead"),
			end: () => calls.push("end"),
			destroy: (receivedError?: Error) => {
				calls.push(receivedError?.message ?? "destroy");
			},
		};

		const handled = hubServer.tryText(res, 500, "<h1>boom</h1>", {}, error);

		expect(handled).toBe(false);
		expect(calls).toEqual(["socket hang up"]);
	});
});
