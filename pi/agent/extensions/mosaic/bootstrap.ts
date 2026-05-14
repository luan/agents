import { readFileSync, unlinkSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMosaicOrchestrationToolName } from "./orchestration-tools.js";

export interface MosaicBootstrapPayload {
	agentId: string;
	agentType: string;
	description: string;
	prompt: string;
	systemPrompt: string;
	builtinToolNames: string[];
	extensions: true | string[] | false;
	disallowedTools?: string[];
	mosaicIdentity?: {
		label: string;
		name: string;
		color: string;
	};
}

let bootstrap: MosaicBootstrapPayload | undefined;
let systemPromptForFirstTurn: string | undefined;
let sentPrompt = false;

export function getMosaicBootstrapMetadata() {
	return bootstrap
		? {
				agentId: bootstrap.agentId,
				agentType: bootstrap.agentType,
				agentDescription: bootstrap.description,
				mosaicAgentLabel: bootstrap.mosaicIdentity?.label,
				mosaicAgentName: bootstrap.mosaicIdentity?.name,
				mosaicAgentColor: bootstrap.mosaicIdentity?.color,
			}
		: {};
}

export function registerMosaicBootstrap(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		loadBootstrap();
		if (!bootstrap || sentPrompt) return;

		pi.setSessionName(bootstrap.description);
		applyActiveTools(pi, bootstrap);
		systemPromptForFirstTurn = bootstrap.systemPrompt;
		sentPrompt = true;

		setTimeout(() => {
			pi.sendUserMessage(bootstrap?.prompt ?? "");
		}, 0);
	});

	pi.on("before_agent_start", async () => {
		if (!systemPromptForFirstTurn) return;
		const systemPrompt = systemPromptForFirstTurn;
		systemPromptForFirstTurn = undefined;
		return { systemPrompt };
	});
}

function loadBootstrap(): void {
	if (bootstrap) return;
	const path = process.env.MOSAIC_BOOTSTRAP_FILE;
	if (!path) return;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MosaicBootstrapPayload>;
		if (
			typeof parsed.agentId === "string" &&
			typeof parsed.agentType === "string" &&
			typeof parsed.description === "string" &&
			typeof parsed.prompt === "string" &&
			typeof parsed.systemPrompt === "string" &&
			Array.isArray(parsed.builtinToolNames)
		) {
			bootstrap = {
				agentId: parsed.agentId,
				agentType: parsed.agentType,
				description: parsed.description,
				prompt: parsed.prompt,
				systemPrompt: parsed.systemPrompt,
				builtinToolNames: parsed.builtinToolNames.filter((name): name is string => typeof name === "string"),
				extensions: normalizeExtensions(parsed.extensions),
				disallowedTools: Array.isArray(parsed.disallowedTools)
					? parsed.disallowedTools.filter((name): name is string => typeof name === "string")
					: undefined,
				mosaicIdentity: normalizeMosaicIdentity(parsed.mosaicIdentity),
			};
		}
	} catch {
		// A bad bootstrap file should not prevent a manually opened mosaic session.
	} finally {
		try {
			unlinkSync(path);
		} catch {}
	}
}

function normalizeMosaicIdentity(value: unknown): MosaicBootstrapPayload["mosaicIdentity"] {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as { label?: unknown; name?: unknown; color?: unknown };
	if (typeof raw.label !== "string" || typeof raw.name !== "string" || typeof raw.color !== "string") {
		return undefined;
	}
	const label = raw.label.trim();
	const name = raw.name.trim();
	const color = raw.color.trim();
	if (!label || !name || !color) return undefined;
	return { label, name, color };
}

function normalizeExtensions(value: unknown): true | string[] | false {
	if (value === false) return false;
	if (Array.isArray(value)) return value.filter((name): name is string => typeof name === "string");
	return true;
}

function applyActiveTools(pi: ExtensionAPI, payload: MosaicBootstrapPayload): void {
	const builtin = new Set(payload.builtinToolNames);
	const disallowed = new Set(payload.disallowedTools ?? []);
	const allToolNames = pi.getAllTools().map((tool) => tool.name);
	const next = allToolNames.filter((toolName) => {
		if (isMosaicOrchestrationToolName(toolName) || disallowed.has(toolName)) return false;
		if (builtin.has(toolName)) return true;
		if (payload.extensions === false) return false;
		if (Array.isArray(payload.extensions)) {
			return payload.extensions.some((extension) => toolName.startsWith(extension) || toolName.includes(extension));
		}
		return true;
	});
	pi.setActiveTools(next);
}
