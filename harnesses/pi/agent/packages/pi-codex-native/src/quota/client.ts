import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_CODEX_BASE_URL, JWT_CLAIM_PATH } from "../provider/constants.ts";
import { parseJson, type JsonValue } from "./json.ts";
import {
	parseCodexUsagePayload,
	parseCodexRateLimitResetCreditsPayload,
	parseCodexRateLimitResetConsumePayload,
	type CodexUsageSnapshot,
} from "./payload.ts";
import { parseCodexReserveStatus } from "./reserve-policy.ts";

type QuotaContext = Pick<ExtensionContext, "model" | "signal"> & {
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
};
type QuotaFetch = (url: string, init: RequestInit) => Promise<Response>;

export function isCanonicalCodexBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.origin === "https://chatgpt.com" &&
			/^\/backend-api(?:\/codex)?\/?$/.test(url.pathname) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}
export function isCanonicalCodexSubscriptionModel(model: Model<Api>): boolean {
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		isCanonicalCodexBaseUrl(model.baseUrl)
	);
}
function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function identity(token: string) {
	const claim = record(
		record(parseJson(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()))[JWT_CLAIM_PATH],
	);
	return {
		accountId: claim.chatgpt_account_id,
		userId: claim.chatgpt_user_id ?? claim.user_id,
		fedramp: claim.chatgpt_account_is_fedramp === true,
	};
}
async function authorization(ctx: QuotaContext) {
	const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = auth?.auth.apiKey;
	if (!token || !isCanonicalCodexBaseUrl(auth?.auth.baseUrl ?? DEFAULT_CODEX_BASE_URL))
		throw new Error("Sign in to the canonical OpenAI Codex subscription provider first");
	const claims = identity(token);
	if (typeof claims.accountId !== "string" || !claims.accountId)
		throw new Error("Codex account identity is unavailable");
	return {
		claims,
		headers: new Headers({
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": claims.accountId,
			accept: "application/json",
			"OAI-Language": "en",
			originator: "pi",
		}),
	};
}
export class CodexQuotaClient {
	constructor(private readonly request: QuotaFetch = fetch) {}
	private async read(path: string, headers: Headers, signal: AbortSignal, body?: string): Promise<JsonValue> {
		const response = await this.request(`${DEFAULT_CODEX_BASE_URL}/wham/${path}`, {
			method: body ? "POST" : "GET",
			headers,
			signal,
			...(body ? { body } : {}),
		});
		if (!response.ok) throw new Error(`Codex ${body ? "reset" : "usage"} request failed (HTTP ${response.status})`);
		return parseJson(await response.text());
	}
	async usage(ctx: QuotaContext): Promise<CodexUsageSnapshot> {
		const { headers, claims } = await authorization(ctx);
		const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(10_000)]);
		const result = parseCodexUsagePayload(await this.read("usage", headers, signal));
		try {
			result.resetCredits =
				parseCodexRateLimitResetCreditsPayload(await this.read("rate-limit-reset-credits", headers, signal)) ??
				result.resetCredits;
		} catch {
			signal.throwIfAborted();
		}
		if (typeof claims.accountId === "string") result.accountId = claims.accountId;
		return result;
	}
	async reserve(ctx: QuotaContext) {
		if (!ctx.model || !isCanonicalCodexSubscriptionModel(ctx.model)) return;
		const { headers, claims } = await authorization(ctx);
		if (typeof claims.accountId !== "string" || typeof claims.userId !== "string" || claims.fedramp) return;
		headers.set("x-openai-codex-luna-reserve", "1");
		const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(10_000)]);
		const data = await this.read("usage", headers, signal);
		const current = (await authorization(ctx)).claims;
		if (current.accountId !== claims.accountId || current.userId !== claims.userId || current.fedramp) return;
		return parseCodexReserveStatus(data, { accountId: claims.accountId, userId: claims.userId }, ctx.model.id);
	}
	/** Call only from an explicitly confirmed action. Retain the same ID after uncertain outcomes. */
	async redeem(ctx: QuotaContext, requestId: string, accountId: string) {
		const { headers, claims } = await authorization(ctx);
		if (claims.accountId !== accountId) throw new Error("Codex account changed; reopen usage before redeeming");
		headers.set("content-type", "application/json");
		return parseCodexRateLimitResetConsumePayload(
			await this.read(
				"rate-limit-reset-credits/consume",
				headers,
				AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(10_000)]),
				JSON.stringify({ redeem_request_id: requestId }),
			),
		);
	}
}
export const newRedemptionId = randomUUID;
