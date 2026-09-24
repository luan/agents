import { expect, test } from "bun:test";
import { CodexQuotaClient, isCanonicalCodexBaseUrl } from "../src/quota/client.ts";
import { parseCodexUsagePayload } from "../src/quota/payload.ts";
import { parseCodexReserveStatus } from "../src/quota/reserve-policy.ts";
import { canRedeem, formatQuota } from "../src/quota/presentation.ts";

const usage = {
	account_id: "account",
	user_id: "user",
	rate_limit: {
		allowed: false,
		primary_window: { used_percent: 95, limit_window_seconds: 18000, reset_at: 1900000000 },
		secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
	},
	rate_limit_reset_credits: { available_count: 1 },
};
const context = (account = "account", baseUrl = "https://chatgpt.com/backend-api") => ({
	model: undefined,
	signal: undefined,
	modelRegistry: {
		async getProviderAuth() {
			return {
				auth: {
					apiKey: `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: "user" } })).toString("base64url")}.test`,
					baseUrl,
				},
			};
		},
	},
});

test("usage separates remaining allowances from unavailable fields and gates credit redemption", () => {
	const result = { ...parseCodexUsagePayload(usage), accountId: "account" };
	expect(formatQuota(result)).toContain("5 hours: 5% remaining");
	expect(formatQuota(result)).toContain("Weekly: 50% remaining");
	expect(canRedeem(result)).toBe(true);
	expect(canRedeem({ ...result, resetCredits: { availableCount: 0, credits: [], raw: null } })).toBe(false);
	expect(canRedeem({ ...result, limits: [{ limitId: "codex", primary: {} }] })).toBe(false);
	expect(formatQuota({ raw: null, limits: [{ limitId: "codex", primary: {} }] })).toContain("unavailable");
});

test("Reserve requires matching account identity and the backend banner, not a quota bucket", () => {
	const identity = { accountId: "account", userId: "user" };
	expect(parseCodexReserveStatus(usage, identity, "gpt-6-astra")?.entryAllowed).toBe(false);
	const reserve = { ...usage, rate_limit_upsell: { banner_type: "luna_reserve", blocked_model_slug: "gpt-6-astra" } };
	expect(parseCodexReserveStatus(reserve, identity, "gpt-6-astra")?.entryAllowed).toBe(true);
	expect(parseCodexReserveStatus(reserve, identity, "gpt-5.5")?.entryAllowed).toBe(false);
	expect(parseCodexReserveStatus(reserve, { ...identity, accountId: "another" }, "gpt-6-astra")).toBeUndefined();
	expect(
		parseCodexReserveStatus(
			{ ...usage, rate_limit: { allowed: true }, rate_limit_upsell: null },
			identity,
			"gpt-reserve",
		)?.ordinaryUsageRecovered,
	).toBe(true);
	expect(
		parseCodexReserveStatus(
			{ ...usage, rate_limit: { allowed: true }, spend_control: { reached: true } },
			identity,
			"gpt-reserve",
		)?.ordinaryUsageRecovered,
	).toBe(false);
});

test("usage reads do not redeem credits; uncertain redemptions reuse their request ID", async () => {
	const calls: { url: string; body?: string }[] = [];
	let fail = true;
	const client = new CodexQuotaClient(async (url, init) => {
		calls.push({ url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
		if (init.method === "POST") {
			if (fail) {
				fail = false;
				throw new Error("connection lost");
			}
			return Response.json({ code: "already_redeemed" });
		}
		return Response.json(url.endsWith("/usage") ? usage : { available_count: 1, credits: [] });
	});
	expect((await client.usage(context())).accountId).toBe("account");
	expect(calls.every((call) => call.body === undefined)).toBe(true);
	await expect(client.redeem(context(), "same-request", "account")).rejects.toThrow("connection lost");
	expect((await client.redeem(context(), "same-request", "account")).outcome).toBe("already_redeemed");
	expect(calls.slice(-2).map((call) => call.body)).toEqual([
		'{"redeem_request_id":"same-request"}',
		'{"redeem_request_id":"same-request"}',
	]);
	const count = calls.length;
	await expect(client.redeem(context("another"), "same-request", "account")).rejects.toThrow("account changed");
	expect(calls).toHaveLength(count);
	await expect(client.usage(context("account", "https://example.com"))).rejects.toThrow("canonical");
	expect(isCanonicalCodexBaseUrl("https://chatgpt.com@evil.example/backend-api")).toBe(false);
});
