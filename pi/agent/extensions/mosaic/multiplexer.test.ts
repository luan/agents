import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanePlacementRequest, TmuxLanePlacementRef, ZellijLanePlacementRef } from "../shared/lane-placement";
import { buildBootstrapPayload } from "./full-session-agent";
import {
	__resetMosaicPlacementForTest,
	currentMultiplexerTarget,
	getMultiplexerBackend,
	launchMosaicTarget,
} from "./multiplexer";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	__resetMosaicPlacementForTest();
});

describe("mosaic full-session placement", () => {
	test("does not treat installed zellij as the current startup target outside a zellij session", () => {
		delete process.env.TMUX;
		delete process.env.TMUX_PANE;
		delete process.env.ZELLIJ;
		delete process.env.ZELLIJ_SESSION_NAME;
		delete process.env.ZELLIJ_PANE_ID;
		const binDir = mkdtempSync(join(tmpdir(), "mosaic-zellij-bin-"));
		const zellij = join(binDir, "zellij");
		writeFileSync(
			zellij,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'  echo "zellij 0.0.0"',
				"  exit 0",
				"fi",
				'echo "There is no active session!" >&2',
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(zellij, 0o755);
		process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? ""}`;

		expect(getMultiplexerBackend()).toBe("zellij");
		expect(currentMultiplexerTarget()).toEqual({});
	});

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

	test("routes later tmux full-session launches under the first agent pane", async () => {
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

	test("serializes parallel tmux launches so only the first splits from the leader pane", async () => {
		process.env.TMUX = "/tmp/tmux";
		process.env.TMUX_PANE = "%self";
		const placementRequests: LanePlacementRequest[] = [];
		let nextPane = 10;

		const deps = {
			backend: () => "tmux" as const,
			tmuxPlace: async (request: LanePlacementRequest) => {
				placementRequests.push(request);
				return {
					backend: "tmux",
					tmux: {
						session: "dev",
						windowId: "dev:2",
						paneId: `%${nextPane++}`,
						placement: "split-pane",
					},
				} satisfies TmuxLanePlacementRef;
			},
			waitForReadyFile: () => {},
			listActive: () => [],
		};

		await Promise.all([
			launchMosaicTarget(
				{
					command: "pi -e mosaic --session /tmp/a.jsonl",
					cwd: "/repo",
					owner: "%self",
					name: "mc: a",
					agentId: "agent-a",
					waitForReady: false,
				},
				deps,
			),
			launchMosaicTarget(
				{
					command: "pi -e mosaic --session /tmp/b.jsonl",
					cwd: "/repo",
					owner: "%self",
					name: "mc: b",
					agentId: "agent-b",
					waitForReady: false,
				},
				deps,
			),
		]);

		expect(placementRequests.map((request) => [request.targetPane, request.splitDirection])).toEqual([
			["%self", "horizontal"],
			["%10", "vertical"],
		]);
	});

	test("can skip old ready-file waiting when native messaging owns readiness", async () => {
		process.env.TMUX = "/tmp/tmux";
		process.env.TMUX_PANE = "%self";
		let waitCalled = false;

		const launched = await launchMosaicTarget(
			{
				command: "pi -e mosaic --session /tmp/child.jsonl",
				cwd: "/repo",
				owner: "%self",
				name: "mc: native",
				agentId: "agent-native",
				waitForReady: false,
			},
			{
				backend: () => "tmux",
				tmuxPlace: async () =>
					({
						backend: "tmux",
						tmux: { session: "$dev", windowId: "$dev:2", paneId: "%9", placement: "split-pane" },
					}) satisfies TmuxLanePlacementRef,
				waitForReadyFile: () => {
					waitCalled = true;
				},
				listActive: () => [],
			},
		);

		expect(waitCalled).toBe(false);
		expect(launched.paneId).toBe("%9");
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
});
