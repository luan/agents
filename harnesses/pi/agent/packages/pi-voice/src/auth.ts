import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface CodexVoiceAuth {
	headers: Headers;
	baseUrl: string;
	officialCodex: boolean;
	env?: Record<string, string>;
}
export async function resolveCodexVoiceAuth(ctx: ExtensionContext): Promise<CodexVoiceAuth> {
	const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = resolved?.auth.apiKey;
	if (!token) throw new Error("Sign in to OpenAI Codex before starting voice");
	const baseUrl = resolved.auth.baseUrl ?? "https://chatgpt.com/backend-api/codex";
	const url = new URL(baseUrl);
	if (
		url.protocol !== "https:" ||
		url.host !== "chatgpt.com" ||
		!/^\/backend-api\/codex\/?$/.test(url.pathname) ||
		url.search ||
		url.hash ||
		url.username ||
		url.password
	)
		throw new Error("Codex voice requires the official Codex endpoint");
	// type-boundary: OAuth JWT payload; the account claim is validated before use as a header.
	type ClaimsBoundary = unknown;
	const claims: ClaimsBoundary = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
	if (!claims || typeof claims !== "object" || !("https://api.openai.com/auth" in claims))
		throw new Error("Codex login has no account identity");
	const auth = claims["https://api.openai.com/auth"];
	if (
		!auth ||
		typeof auth !== "object" ||
		!("chatgpt_account_id" in auth) ||
		typeof auth.chatgpt_account_id !== "string" ||
		!auth.chatgpt_account_id
	)
		throw new Error("Codex login has no account identity");
	const headers = new Headers();
	for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) if (value !== null) headers.set(name, value);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", auth.chatgpt_account_id);
	headers.set("originator", "pi");
	headers.set("x-session-id", ctx.sessionManager.getSessionId());
	headers.set("user-agent", "pi-voice");
	return { headers, baseUrl, officialCodex: true, ...(resolved.env ? { env: resolved.env } : {}) };
}
