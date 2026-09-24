import { compact, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
/** Use Pi's cumulative summarizer on an isolated SSE request, without touching the live continuation. */
export async function portableSummary(
	event: Pick<SessionBeforeCompactEvent, "preparation" | "signal" | "customInstructions">,
	ctx: ExtensionContext,
) {
	if (!ctx.model) throw new Error("No model for portable compaction");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
	if (!provider) throw new Error("Portable summary provider is unavailable");
	return compact(
		event.preparation,
		ctx.model,
		auth.apiKey,
		auth.headers
			? Object.fromEntries(
					Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				)
			: undefined,
		event.customInstructions,
		event.signal,
		"low",
		(model, context, options) =>
			provider.streamSimple(model, context, { ...options, ...auth, sessionId: undefined, transport: "sse" }),
	);
}
