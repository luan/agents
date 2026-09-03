import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	publishPromptAuditEntries,
	registerPromptAuditEntryRenderers,
	removeLegacyPromptAuditEntries,
	removeLegacyPromptAuditMessages,
} from "./audit-entries.ts";
import { AGENTS_CONTEXT_MESSAGE_ID, injectAgentsContext, renderAgentsContext } from "./context-messages.ts";
import { composeDeveloperMessages, type DeveloperMessage } from "./developer-messages.ts";
import { getSystemPromptPayloadAdapterRegistry } from "./provider-payload.ts";
import {
	promptEnvelopeRequests,
	registerPromptEnvelopeService,
	type PromptEnvelopeRequest,
	type PromptEnvelopeService,
} from "./prompt-envelope.ts";
import { buildProviderInstructions } from "./provider-instructions.ts";
import { getDeveloperPromptSettings, registerDeveloperPromptXSettings } from "./contributions/xsettings.ts";

interface SessionPromptState {
	base?: string;
	lastGood?: string;
	lastGoodProvider?: string;
	developerMessages: DeveloperMessage[];
	agentsContext?: string;
}

export default function developerPromptExtension(pi: ExtensionAPI): void {
	registerDeveloperPromptExtension(pi);
}

export function registerDeveloperPromptExtension(pi: ExtensionAPI): void {
	registerPromptAuditEntryRenderers(pi);
	const unregisterXSettings = registerDeveloperPromptXSettings();
	const sessions = new Map<string, SessionPromptState>();
	const contexts = new Map<string, ExtensionContext>();
	const requests = promptEnvelopeRequests();
	const buildEnvelope = (request: PromptEnvelopeRequest) => {
		const systemPrompt = buildProviderInstructions(request.systemPromptOptions, request.piSystemPrompt);
		const developerMessages = composeDeveloperMessages(request, request.cwd);
		const agentsContext = renderAgentsContext(request.systemPromptOptions.contextFiles ?? [], request.cwd);
		return {
			systemPrompt,
			developerMessages,
			contextualUserMessages: agentsContext ? [{ id: AGENTS_CONTEXT_MESSAGE_ID, content: agentsContext }] : [],
		};
	};
	const envelopeService: PromptEnvelopeService = {
		capture(request) {
			requests.set(request.sessionId, request);
			const envelope = buildEnvelope(request);
			const state = sessionStateById(sessions, request.sessionId);
			state.base = request.piSystemPrompt;
			state.developerMessages = envelope.developerMessages;
			state.agentsContext = envelope.contextualUserMessages[0]?.content;
			state.lastGood = envelope.systemPrompt;
			state.lastGoodProvider = request.provider;
			const context = contexts.get(request.sessionId);
			if (context) {
				publishPromptAuditEntries(
					pi,
					context.sessionManager.getBranch(),
					envelope,
					getDeveloperPromptSettings().auditEntries,
				);
			}
			return envelope;
		},
		current(sessionId, overrides) {
			const request = requests.get(sessionId);
			return request ? buildEnvelope({ ...request, ...overrides }) : undefined;
		},
		clear(sessionId) {
			requests.delete(sessionId);
		},
	};
	const unregisterEnvelopeService = registerPromptEnvelopeService(envelopeService);
	pi.on("session_start", (_event, ctx) => {
		contexts.set(ctx.sessionManager.getSessionId(), ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		const state = sessionState(sessions, ctx);
		try {
			const provider = ctx.model?.provider;
			const activeTools = pi.getActiveTools();
			const sessionId = ctx.sessionManager.getSessionId();
			const envelope = envelopeService.capture({
				provider,
				activeTools,
				sessionId,
				prompt: event.prompt,
				systemPromptOptions: event.systemPromptOptions,
				cwd: ctx.cwd,
				piSystemPrompt: event.systemPrompt,
			});
			if (!contexts.has(sessionId)) {
				publishPromptAuditEntries(
					pi,
					ctx.sessionManager.getBranch(),
					envelope,
					getDeveloperPromptSettings().auditEntries,
				);
			}
			return { systemPrompt: envelope.systemPrompt };
		} catch (error) {
			try {
				ctx.ui?.notify?.(
					`System prompt build failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} catch {
				// A UI failure must not remove the last valid prompt.
			}
			if (state.lastGood !== undefined && state.lastGoodProvider === ctx.model?.provider) {
				return { systemPrompt: state.lastGood };
			}
			state.agentsContext = undefined;
			return undefined;
		}
	});

	pi.on("context", (event, ctx) => {
		const filteredAudit = removeLegacyPromptAuditMessages(event.messages);
		const withoutAudit = filteredAudit ?? event.messages;
		const messages = injectAgentsContext(withoutAudit, sessionState(sessions, ctx).agentsContext) ?? filteredAudit;
		return messages ? { messages } : undefined;
	});

	pi.on("session_before_compact", (event) => {
		replaceArray(
			event.preparation.messagesToSummarize,
			removeLegacyPromptAuditMessages(event.preparation.messagesToSummarize),
		);
		replaceArray(
			event.preparation.turnPrefixMessages,
			removeLegacyPromptAuditMessages(event.preparation.turnPrefixMessages),
		);
	});

	pi.on("session_before_tree", (event) => {
		replaceArray(
			event.preparation.entriesToSummarize,
			removeLegacyPromptAuditEntries(event.preparation.entriesToSummarize),
		);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = sessionState(sessions, ctx);
		const provider = ctx.model?.provider;
		if (state.base === undefined || state.lastGood === undefined || !provider || state.lastGoodProvider !== provider)
			return;
		const adapter = getSystemPromptPayloadAdapterRegistry().get(provider);
		if (!adapter) return;
		let payload = event.payload;
		let changed = false;
		if (adapter.readSystemPrompt(payload) === state.base) {
			payload = adapter.replaceSystemPrompt(payload, state.lastGood);
			changed = true;
		}
		if (adapter.replaceDeveloperMessages) {
			payload = adapter.replaceDeveloperMessages(
				payload,
				state.developerMessages.map(({ id, content }) => ({ id, content })),
			);
			changed = true;
		}
		return changed ? payload : undefined;
	});

	pi.on("session_shutdown", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		sessions.delete(sessionId);
		contexts.delete(sessionId);
		requests.delete(sessionId);
		if (event.reason === "reload" || event.reason === "quit") {
			unregisterEnvelopeService();
			unregisterXSettings();
		}
	});
}

function replaceArray<T>(target: T[], replacement: T[] | undefined): void {
	if (replacement) target.splice(0, target.length, ...replacement);
}

function sessionState(sessions: Map<string, SessionPromptState>, ctx: ExtensionContext): SessionPromptState {
	return sessionStateById(sessions, ctx.sessionManager.getSessionId());
}

function sessionStateById(sessions: Map<string, SessionPromptState>, id: string): SessionPromptState {
	let state = sessions.get(id);
	if (!state) {
		state = { developerMessages: [] };
		sessions.set(id, state);
	}
	return state;
}
