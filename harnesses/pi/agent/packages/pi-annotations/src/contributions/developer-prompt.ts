import { parseEnvelope } from "../core/envelope.ts";

const CONTRIBUTIONS = Symbol.for("pi-developer-prompt/developer-messages/v1");
const ENVELOPE_SERVICE = Symbol.for("pi-developer-prompt/envelope-service/v1");
const CONTRIBUTION_ID = "pi-annotations/directives";

export const ANNOTATION_SYSTEM_GUIDANCE =
	'When referring to one of the current user\'s response annotations, emit :pi-annotation{index="N"} outside code, using its 1-based array index.';

interface DeveloperMessageContext {
	prompt?: string;
}

interface DeveloperMessageContribution {
	id: string;
	priority: number;
	content(context: DeveloperMessageContext): string | undefined;
}

interface ContributionRegistry extends Map<string, DeveloperMessageContribution> {
	protocol: "pi-developer-prompt/developer-messages/v1";
	version: 1;
}
type PromptCapabilities = typeof globalThis & {
	[CONTRIBUTIONS]?: ContributionRegistry;
	[ENVELOPE_SERVICE]?: object;
};

export function registerAnnotationDeveloperPrompt(): () => void {
	const root = globalThis as PromptCapabilities;
	const registry = isContributionRegistry(root[CONTRIBUTIONS])
		? root[CONTRIBUTIONS]
		: (Object.assign(new Map<string, DeveloperMessageContribution>(), {
				protocol: "pi-developer-prompt/developer-messages/v1" as const,
				version: 1 as const,
			}) as ContributionRegistry);
	root[CONTRIBUTIONS] = registry;
	const contribution: DeveloperMessageContribution = {
		id: CONTRIBUTION_ID,
		priority: 100,
		content: ({ prompt }) => (prompt && parseEnvelope(prompt) ? ANNOTATION_SYSTEM_GUIDANCE : undefined),
	};
	registry.set(CONTRIBUTION_ID, contribution);
	return () => {
		if (registry.get(CONTRIBUTION_ID) === contribution) registry.delete(CONTRIBUTION_ID);
	};
}

export function hasDeveloperPromptHost(): boolean {
	return (globalThis as PromptCapabilities)[ENVELOPE_SERVICE] !== undefined;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isContributionRegistry(value: unknown): value is ContributionRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ContributionRegistry>;
	return (
		candidate.protocol === "pi-developer-prompt/developer-messages/v1" &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.values === "function"
	);
}
