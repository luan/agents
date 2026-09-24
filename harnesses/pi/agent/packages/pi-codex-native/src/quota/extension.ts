import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ComponentStack, DialogButtonBar, DialogOverlay } from "@luan.sh/pi-libtui";
import { registerAction } from "@luan.sh/pi-libactions/sdk";
import { getCodexNativeSettings } from "../contributions/xsettings.ts";
import { CodexQuotaClient, newRedemptionId } from "./client.ts";
import { createCodexReserveController } from "./reserve.ts";
import { canRedeem, formatQuota, quotaText } from "./presentation.ts";
const REDEEM_ENTRY = "pi-codex-native/reset-credit/v1";
interface PendingRedemption {
	id: string;
	accountId: string;
}
function pendingRedemption(ctx: ExtensionContext): PendingRedemption | undefined {
	const entry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === REDEEM_ENTRY);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") return;
	if (
		!("id" in entry.data) ||
		typeof entry.data.id !== "string" ||
		!("accountId" in entry.data) ||
		typeof entry.data.accountId !== "string"
	)
		return;
	return { id: entry.data.id, accountId: entry.data.accountId };
}
export function registerQuotaManagement(pi: ExtensionAPI): () => void {
	const client = new CodexQuotaClient();
	const reserve = createCodexReserveController(pi, client);
	let showing = false;
	const open = async (ctx: ExtensionContext) => {
		if (showing) return;
		showing = true;
		try {
			while (!ctx.signal?.aborted) {
				const snapshot = await client.usage(ctx);
				const pending = pendingRedemption(ctx);
				const retry = pending?.accountId === snapshot.accountId;
				const allowed = retry || canRedeem(snapshot);
				const action =
					ctx.mode === "tui"
						? await ctx.ui.custom<"refresh" | "redeem" | "close">(
								(tui, theme, _keys, done) => {
									const buttons = new DialogButtonBar({
										theme,
										requestRender: () => tui.requestRender(),
										onActivate: done,
										buttons: [
											{
												value: "refresh" as const,
												label: "Refresh",
												shortcuts: ["r"],
												foreground: "text.primary",
												background: "action.neutral",
											},
											...(allowed
												? [
														{
															value: "redeem" as const,
															label: retry ? "Retry credit reset" : "Redeem one credit",
															shortcuts: ["c"] as const,
															foreground: "warning" as const,
															background: "action.neutral" as const,
														},
													]
												: []),
											{
												value: "close" as const,
												label: "Close",
												shortcuts: ["escape"],
												foreground: "text.primary",
												background: "action.neutral",
											},
										],
									});
									return new DialogOverlay(
										theme,
										new ComponentStack([new Text(quotaText(snapshot, theme), 1, 1), buttons], { activeChild: 1 }),
										snapshot.planType
											? `Codex usage · ${snapshot.planType[0]?.toUpperCase()}${snapshot.planType.slice(1)}`
											: "Codex usage",
									);
								},
								{ overlay: true, overlayOptions: { width: 72, anchor: "center" } },
							)
						: await ctx.ui.select(
								formatQuota(snapshot),
								allowed ? ["Refresh", "Redeem one credit", "Close"] : ["Refresh", "Close"],
							);
				if (action === "refresh" || action === "Refresh") continue;
				if (action !== "redeem" && action !== "Redeem one credit") break;
				if (
					!snapshot.accountId ||
					!(await ctx.ui.confirm(
						"Redeem one Codex reset credit?",
						retry
							? "Retry the same pending reset. This cannot spend a second credit for that attempt."
							: "Use one banked credit to reset eligible Codex usage limits.",
					))
				)
					continue;
				const request = retry ? pending! : { id: newRedemptionId(), accountId: snapshot.accountId };
				pi.appendEntry(REDEEM_ENTRY, request);
				try {
					const result = await client.redeem(ctx, request.id, request.accountId);
					if (result.outcome !== "unknown") pi.appendEntry(REDEEM_ENTRY, null);
					ctx.ui.notify(
						result.outcome === "reset" || result.outcome === "already_redeemed"
							? "Codex usage reset completed."
							: `Reset result: ${result.outcome.replaceAll("_", " ")}.`,
						result.outcome === "unknown" ? "warning" : "info",
					);
				} catch (error) {
					ctx.ui.notify(
						`${error instanceof Error ? error.message : String(error)}. The same reset attempt is saved for retry.`,
						"warning",
					);
				}
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			showing = false;
		}
	};
	const dispose = registerAction({
		id: "codex.usage.open",
		description: "Open Codex usage and reset credits",
		run: open,
	});
	pi.on("model_select", (_event, ctx) => {
		reserve.modelSelected(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await reserve.beforeTurn(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (getCodexNativeSettings(ctx.sessionManager.getSessionId()).lunaReserve) await reserve.settled(ctx);
	});
	const cleanup = () => {
		dispose();
	};
	pi.on("session_shutdown", cleanup);
	return cleanup;
}
