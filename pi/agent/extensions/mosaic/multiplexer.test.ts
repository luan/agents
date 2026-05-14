import { afterEach, describe, expect, test } from "bun:test";
import type { LanePlacementRequest, TmuxLanePlacementRef, ZellijLanePlacementRef } from "../shared/lane-placement";
import { buildBootstrapPayload } from "./full-session-agent";
import { launchMosaicTarget, sendMessageToTarget } from "./multiplexer";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("mosaic full-session placement", () => {
	test("routes tmux full-session launch through shared placement while preserving ready env and live target metadata", async () => {
		process.env.TMUX = "/tmp/tmux";
		process.env.TMUX_PANE = "%self";
		process.env.MOSAIC_SHELL = "/bin/zsh";
		let placementRequest: LanePlacementRequest | undefined;
		let readyPath = "";
		let readyTimeoutMs = 0;
		let listCalls = 0;

		const launched = await launchMosaicTarget(
			{
				command: "pi -e mosaic --session /tmp/child.jsonl --model openai/gpt-5",
				cwd: "/repo",
				owner: "%self",
				name: "mc: inspect",
				agentId: "agent-1",
				extraEnv: { MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json" },
			},
			{
				backend: () => "tmux",
				execFileSync: () => "$dev",
				tmuxPlace: async (request) => {
					placementRequest = request;
					return {
						backend: "tmux",
						tmux: {
							session: "$dev",
							windowId: "$dev:2",
							paneId: "%9",
							placement: "split-pane",
						},
					} satisfies TmuxLanePlacementRef;
				},
				waitForReadyFile: (path, timeoutMs) => {
					readyPath = path;
					readyTimeoutMs = timeoutMs;
				},
				listActive: () => {
					listCalls++;
					return listCalls === 1
						? []
						: [
								{
									backend: "tmux",
									paneId: "%live",
									sessionFile: "/tmp/child.jsonl",
									cwd: "/repo",
									pid: 123,
									owner: "%self",
									busy: false,
									agentId: "agent-1",
									tmuxSession: "$dev",
									windowId: "@live",
									windowName: "mc: inspect",
								},
							];
				},
			},
		);

		expect(placementRequest).toMatchObject({
			placement: "split-pane",
			cwd: "/repo",
			name: "mc: inspect",
			command: "pi -e mosaic --session /tmp/child.jsonl --model openai/gpt-5",
			targetPane: "%self",
			restoreFocusPane: "%self",
			splitDirection: "horizontal",
		});
		expect(placementRequest?.env).toMatchObject({
			MOSAIC_OWNER: "%self",
			MOSAIC_READY_FILE: readyPath,
			MOSAIC_SHELL: "/bin/zsh",
			MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json",
		});
		expect(readyTimeoutMs).toBe(30_000);
		expect(launched).toMatchObject({
			backend: "tmux",
			paneId: "%live",
			windowId: "@live",
			windowName: "mc: inspect",
			tmuxSession: "$dev",
		});
		expect(launched.placement).toEqual({
			backend: "tmux",
			tmux: {
				session: "$dev",
				windowId: "$dev:2",
				paneId: "%9",
				placement: "split-pane",
			},
		});
	});

	test("routes later tmux full-session launches below the first agent pane", async () => {
		process.env.TMUX = "/tmp/tmux";
		process.env.TMUX_PANE = "%self";
		let placementRequest: LanePlacementRequest | undefined;

		await launchMosaicTarget(
			{
				command: "pi -e mosaic --session /tmp/child.jsonl",
				cwd: "/repo",
				owner: "%self",
				name: "mc: second",
				agentId: "agent-2",
			},
			{
				backend: () => "tmux",
				tmuxPlace: async (request) => {
					placementRequest = request;
					return {
						backend: "tmux",
						tmux: {
							session: "dev",
							windowId: "dev:2",
							paneId: "%11",
							placement: "split-pane",
						},
					} satisfies TmuxLanePlacementRef;
				},
				waitForReadyFile: () => {},
				listActive: () => [
					{
						backend: "tmux",
						paneId: "%10",
						sessionFile: "/tmp/first.jsonl",
						cwd: "/repo",
						pid: 123,
						owner: "%self",
						busy: false,
						agentId: "agent-1",
					},
				],
			},
		);

		expect(placementRequest).toMatchObject({
			placement: "split-pane",
			targetPane: "%10",
			restoreFocusPane: "%self",
			splitDirection: "vertical",
		});
	});

	test("routes active zellij full-session launch through a split pane", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "dev";
		process.env.ZELLIJ_PANE_ID = "1";
		let placementRequest: LanePlacementRequest | undefined;

		const launched = await launchMosaicTarget(
			{
				command: "pi -e mosaic --session /tmp/child.jsonl",
				cwd: "/repo",
				owner: "terminal_1",
				name: "mc: plan",
				agentId: "agent-3",
				extraEnv: { MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json" },
			},
			{
				backend: () => "zellij",
				zellijPlace: async (request) => {
					placementRequest = request;
					return {
						backend: "zellij",
						zellij: {
							session: request.targetWorkspace,
							paneId: "terminal_2",
							placement: "split-pane",
						},
					} satisfies ZellijLanePlacementRef;
				},
				waitForReadyFile: () => {},
				listActive: () => [],
			},
		);

		expect(placementRequest).toMatchObject({
			placement: "split-pane",
			targetWorkspace: "dev",
			targetPane: "terminal_1",
			restoreFocusPane: "terminal_1",
			splitDirection: "horizontal",
			cwd: "/repo",
			name: "mc: plan",
			command: "pi -e mosaic --session /tmp/child.jsonl",
		});
		expect(launched).toMatchObject({
			backend: "zellij",
			paneId: "terminal_2",
			zellijSession: "dev",
		});
	});

	test("routes installed zellij full-session launch as a hidden background session", async () => {
		let placementRequest: LanePlacementRequest | undefined;

		const launched = await launchMosaicTarget(
			{
				command: "pi -e mosaic --session /tmp/child.jsonl",
				cwd: "/repo",
				owner: "mosaic",
				name: "mc: plan",
				agentId: "agent-2",
				extraEnv: { MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json" },
			},
			{
				backend: () => "zellij",
				zellijPlace: async (request) => {
					placementRequest = request;
					return {
						backend: "zellij",
						zellij: {
							session: request.targetWorkspace,
							tabId: "7",
							tabName: request.name,
							placement: "hidden",
							sessionOwned: true,
						},
					} satisfies ZellijLanePlacementRef;
				},
				waitForReadyFile: () => {},
				listActive: () => [],
			},
		);

		expect(placementRequest).toMatchObject({
			placement: "hidden",
			targetWorkspace: "mosaic-agent-2",
			cwd: "/repo",
			name: "mc: plan",
			command: "pi -e mosaic --session /tmp/child.jsonl",
		});
		expect(placementRequest?.env).toMatchObject({
			MOSAIC_OWNER: "mosaic",
			MOSAIC_ZELLIJ_SESSION_OWNED: "1",
			MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json",
		});
		expect(launched).toMatchObject({
			backend: "zellij",
			windowId: "7",
			zellijSession: "mosaic-agent-2",
			zellijTabId: "7",
			zellijTabName: "mc: plan",
			zellijSessionOwned: true,
		});
	});

	test("bootstrap payload shape remains lifecycle-owned by mosaic", () => {
		expect(
			buildBootstrapPayload({
				agentId: "agent-1",
				agentType: "general-purpose",
				description: "Inspect docs",
				prompt: "Read the docs",
				systemPrompt: "You are an agent",
				builtinToolNames: ["read", "edit"],
				extensions: ["spawn"],
				disallowedTools: ["Agent"],
				mosaicIdentity: { label: "A1", name: "Inspect docs", color: "f38ba8" },
			}),
		).toEqual({
			agentId: "agent-1",
			agentType: "general-purpose",
			description: "Inspect docs",
			prompt: "Read the docs",
			systemPrompt: "You are an agent",
			builtinToolNames: ["read", "edit"],
			extensions: ["spawn"],
			disallowedTools: ["Agent"],
			mosaicIdentity: { label: "A1", name: "Inspect docs", color: "f38ba8" },
		});
	});

	test("tmux steering enters insert mode before typing the literal message", () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		sendMessageToTarget(
			{
				backend: "tmux",
				paneId: "%target",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/repo",
				pid: 123,
				owner: "%self",
				busy: false,
			},
			"review only the diff",
			((file: string, args: string[]) => {
				calls.push({ file, args });
				return "";
			}) as never,
		);

		expect(calls.map((call) => [call.file, call.args[0]])).toEqual([
			["tmux", "send-keys"],
			["tmux", "send-keys"],
			["tmux", "send-keys"],
		]);
		expect(calls[0]?.args).toEqual(["send-keys", "-t", "%target", "Escape", "i"]);
		expect(calls[1]?.args).toEqual(["send-keys", "-t", "%target", "-l", "--", "review only the diff"]);
		expect(calls[2]?.args).toEqual(["send-keys", "-t", "%target", "Enter"]);
	});

	test("zellij steering enters insert mode before writing the message", () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		sendMessageToTarget(
			{
				backend: "zellij",
				paneId: "terminal_2",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/repo",
				pid: 123,
				owner: "terminal_1",
				busy: false,
				zellijSession: "dev",
			},
			"review only the diff",
			((file: string, args: string[]) => {
				calls.push({ file, args });
				return "";
			}) as never,
		);

		expect(calls).toHaveLength(3);
		expect(calls[0]?.file).toBe("zellij");
		expect(calls[0]?.args).toContain("\x1bi");
		expect(calls[1]?.args).toContain("review only the diff");
		expect(calls[2]?.args).toContain("\r");
	});
});
