import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { getSubagentConfig, type SubagentConfig } from "../config/settings.ts";
import { multiAgentModeInstructions, multiAgentRoleInstructions } from "../core/instructions.ts";
import { getCoordinatorForSession } from "../runtime/coordinator.ts";

const REGISTRY_KEY = Symbol.for("pi-developer-prompt/developer-messages/v1");
const ENVELOPE_SERVICE_KEY = Symbol.for("pi-developer-prompt/envelope-service/v1");
const REGISTRATION_STATE_KEY = Symbol.for("pi-subagents/developer-prompt-registration/v1");

interface RenderContext {
	activeTools: readonly string[];
	sessionId: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

interface Contribution {
	id: string;
	priority: number;
	activeTools: readonly string[];
	content: (context: RenderContext) => string | undefined;
}

interface ContributionRegistry extends Map<string, Contribution> {
	protocol: "pi-developer-prompt/developer-messages/v1";
	version: 1;
}

interface RegistrationState {
	refs: number;
	role: Contribution;
	mode: Contribution;
}

type ContributionGlobal = typeof globalThis & { [REGISTRY_KEY]?: ContributionRegistry };
type RegistrationGlobal = typeof globalThis & { [REGISTRATION_STATE_KEY]?: RegistrationState };

export function hasDeveloperPromptHost(): boolean {
	const value = (globalThis as Record<symbol, UntrustedEnvelopeService>)[ENVELOPE_SERVICE_KEY];
	return Boolean(value && typeof value === "object" && "capture" in value && typeof value.capture === "function");
}

export function registerCurrentSubagentPromptContributions(): () => void {
	return registerSubagentPromptContributions(getSubagentConfig, (sessionId) => {
		const coordinator = getCoordinatorForSession(sessionId);
		if (!coordinator || sessionId === coordinator.rootSessionId) return "/root";
		return coordinator.pathForSession(sessionId) ?? "/root";
	});
}

export function registerSubagentPromptContributions(
	getConfig: () => SubagentConfig,
	resolveAgentPath: (sessionId: string) => string,
): () => void {
	const root = globalThis as RegistrationGlobal;
	const registry = contributionRegistry();
	const existing = root[REGISTRATION_STATE_KEY];
	if (existing) {
		existing.refs++;
		registry.set(existing.role.id, existing.role);
		registry.set(existing.mode.id, existing.mode);
		return () => releaseRegistration(root, registry, existing);
	}

	const role: Contribution = {
		id: "pi-subagents/role",
		priority: 30,
		activeTools: ["spawn_agent"],
		content: ({ sessionId }) => {
			const config = getConfig();
			return multiAgentRoleInstructions(resolveAgentPath(sessionId), config.maxConcurrency);
		},
	};
	const mode: Contribution = {
		id: "pi-subagents/mode",
		priority: 31,
		activeTools: ["spawn_agent"],
		content: () => multiAgentModeInstructions(getConfig().multiAgentMode),
	};
	const state: RegistrationState = { refs: 1, role, mode };
	root[REGISTRATION_STATE_KEY] = state;
	registry.set(role.id, role);
	registry.set(mode.id, mode);
	return () => releaseRegistration(root, registry, state);
}

function releaseRegistration(root: RegistrationGlobal, registry: ContributionRegistry, state: RegistrationState): void {
	if (root[REGISTRATION_STATE_KEY] !== state || --state.refs > 0) return;
	if (registry.get(state.role.id) === state.role) registry.delete(state.role.id);
	if (registry.get(state.mode.id) === state.mode) registry.delete(state.mode.id);
	delete root[REGISTRATION_STATE_KEY];
}

function contributionRegistry(): ContributionRegistry {
	const root = globalThis as ContributionGlobal;
	const existing = root[REGISTRY_KEY];
	if (isContributionRegistry(existing)) return existing;
	const registry = Object.assign(new Map<string, Contribution>(), {
		protocol: "pi-developer-prompt/developer-messages/v1" as const,
		version: 1 as const,
	}) as ContributionRegistry;
	root[REGISTRY_KEY] = registry;
	return registry;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; these validators narrow them immediately.
type UntrustedContributionRegistry = unknown;
type UntrustedEnvelopeService = unknown;

function isContributionRegistry(value: UntrustedContributionRegistry): value is ContributionRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ContributionRegistry>;
	return (
		candidate.protocol === "pi-developer-prompt/developer-messages/v1" &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function"
	);
}
