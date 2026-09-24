import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ComponentStack, DialogButtonBar, tuiTheme } from "@luan.sh/pi-libtui";
import { getPromptEnvelopeService, registerDeveloperMessageContribution } from "@luan.sh/pi-developer-messages";
import { VoiceController } from "./controller.ts";
import { voiceControls } from "./ui.ts";
import { voiceSettings } from "./settings.ts";
import type { PhoneServer } from "./lan/server.ts";
const GUIDANCE =
	"Voice is connected to this Pi session. Treat the input in realtime_delegation as the user's request with the same authority as typed input. Its transcript_delta is prior conversation. Give concise progress and results that can be spoken; keep code, tables, and detailed artifacts in the normal Pi output. Never claim an operation succeeded before its result arrives.";
export default function voiceExtension(pi: ExtensionAPI): void {
	const controller = new VoiceController(pi);
	let phone: PhoneServer | undefined;
	let context: ExtensionContext | undefined;
	let boundary: string | null | undefined;
	let archivedLeaf: string | undefined;
	const showPhone = async (ctx: ExtensionContext) => {
		phone ??= await (await import("./lan/server.ts")).startPhoneServer(pi, ctx, controller);
		const text = `Open this private link on a phone on the same network. Accept this computer's local certificate in the browser.\n\n${phone.urls.join("\n\n")}\n\nThe link grants access to this Pi session. Stop phone access when finished.`;
		const action =
			ctx.mode === "tui"
				? await ctx.ui.custom<"close" | "stop">(
						(tui, theme, _keys, done) =>
							new ComponentStack([
								new Text(tuiTheme(theme).fg("text.primary", text), 1, 1),
								new DialogButtonBar({
									theme,
									requestRender: () => tui.requestRender(),
									onActivate: done,
									buttons: [
										{ value: "close", label: "Close", foreground: "text.primary", background: "action.neutral" },
										{
											value: "stop",
											label: "Stop phone access",
											foreground: "text.primary",
											background: "action.neutral",
										},
									],
								}),
							]),
					)
				: await ctx.ui.select(text, ["Close", "Stop phone access"]);
		if (action === "stop" || action === "Stop phone access") {
			await phone.close();
			phone = undefined;
		}
	};
	const disposers = [
		voiceSettings.register(),
		voiceControls(pi, controller, showPhone),
		registerDeveloperMessageContribution({
			id: "pi-voice/instructions",
			priority: 36,
			content: ({ sessionId }) =>
				controller.active && sessionId === context?.sessionManager.getSessionId() ? GUIDANCE : undefined,
		}),
	];
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		controller.bind(ctx);
		boundary = windowBoundary(ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		context = ctx;
		controller.bind(ctx);
		const next = windowBoundary(ctx);
		if (next !== boundary) {
			boundary = next;
			await controller.refresh(ctx, archivedLeaf);
			archivedLeaf = undefined;
		}
		if (controller.active && !getPromptEnvelopeService())
			return { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` };
	});
	pi.on("input", (event) => {
		if (event.source !== "extension") controller.input(event.text, event.streamingBehavior);
	});
	pi.on("message_update", (event) => {
		if (event.assistantMessageEvent.type === "text_delta") controller.delta(event.assistantMessageEvent.delta);
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = event.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (event.message.stopReason === "error")
			controller.result(event.message.errorMessage ?? "The current work failed", true);
		else if (text) {
			controller.result(text, event.message.stopReason !== "toolUse");
			phone?.message(text);
		}
	});
	pi.on("agent_end", () => controller.settle());
	pi.on("agent_settled", () => controller.settle());
	pi.on("session_before_compact", (event) => {
		if (controller.active) controller.compaction(event.signal);
	});
	pi.on("session_compact", async (_event, ctx) => {
		boundary = windowBoundary(ctx);
		await controller.compacted(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		const next = windowBoundary(ctx);
		if (next !== boundary) {
			boundary = next;
			await controller.compacted(ctx);
		}
	});
	pi.on("session_tree", async (event, ctx) => {
		if (
			event.summaryEntry?.details &&
			typeof event.summaryEntry.details === "object" &&
			"contextArchive" in event.summaryEntry.details
		) {
			archivedLeaf = event.oldLeafId ?? undefined;
			return;
		}
		boundary = windowBoundary(ctx);
		await controller.compacted(ctx);
	});
	for (const channel of ["pi-context/compaction/v1", "pi-codex-native/compaction/v1"])
		disposers.push(
			pi.events.on(channel, (value) => {
				if (
					!value ||
					typeof value !== "object" ||
					!("version" in value) ||
					value.version !== 1 ||
					!("sessionId" in value) ||
					value.sessionId !== context?.sessionManager.getSessionId() ||
					!("phase" in value)
				)
					return;
				if (value.phase === "start" && controller.active) controller.compaction();
				else if (value.phase === "cancel") controller.cancelCompaction();
			}),
		);
	const close = async () => {
		await controller.stop(false);
		await phone?.close();
		phone = undefined;
	};
	pi.on("session_before_switch", close);
	pi.on("session_shutdown", async () => {
		await close();
		for (const dispose of disposers) dispose();
	});
}
function windowBoundary(ctx: ExtensionContext): string | null {
	return (
		[...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-context/window")?.id ?? null
	);
}
