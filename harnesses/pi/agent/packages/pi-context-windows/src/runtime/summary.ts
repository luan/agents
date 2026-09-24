import { generateSummaryWithUsage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
export async function summarizeWindow(
	ctx: ExtensionContext,
	messages: AgentMessage[],
	previous?: string,
	instructions?: string,
	signal = ctx.signal,
) {
	const model = ctx.model;
	if (!model) throw new Error("Select a model before generating a context summary");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error("Summary provider is unavailable");
	return generateSummaryWithUsage(
		messages,
		model,
		16_384,
		auth.apiKey,
		auth.headers
			? Object.fromEntries(
					Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				)
			: undefined,
		signal,
		instructions,
		previous,
		"low",
		(target, context, options) =>
			provider.streamSimple(target, context, { ...options, ...auth, sessionId: undefined, transport: "sse" }),
	);
}
