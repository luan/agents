import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SelectBox, tuiTheme } from "@luan.sh/pi-libtui";
import { loadActionKeybindings, registerAction } from "@luan.sh/pi-libactions/sdk";
import type { VoiceController } from "./controller.ts";
type VoiceAction = "start" | "dictate" | "mute" | "stop" | "phone";
export function voiceControls(
	pi: ExtensionAPI,
	controller: VoiceController,
	phone: (ctx: ExtensionContext) => Promise<void>,
): () => void {
	let context: ExtensionContext | undefined;
	const controlsKey = loadActionKeybindings()["voice.open"]?.[0];
	pi.registerMessageRenderer(
		"pi-voice/transcript",
		(message, options, theme) =>
			new Text(
				`${tuiTheme(theme).fg("accent", "You · voice")}\n${typeof message.content === "string" ? message.content : ""}`,
				options.outputPad,
				0,
			),
	);
	pi.registerMessageRenderer("pi-voice/delegation", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const input = (content.match(/<input>([\s\S]*?)<\/input>/u)?.[1] ?? content)
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&");
		return new Text(`${tuiTheme(theme).fg("accent", "Voice request")}\n${input}`, options.outputPad, 0);
	});
	for (const [type, label] of [
		["pi-voice/transcript", "You · voice"],
		["pi-voice/reply", "Assistant · voice"],
	] as const) {
		pi.registerEntryRenderer(type, (entry, _options, theme) => {
			const data = entry.data;
			const text = data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : "";
			return new Text(`${tuiTheme(theme).fg("accent", label)}\n${text}`, 1, 0);
		});
	}
	const run = (action: VoiceAction, ctx: ExtensionContext) => {
		const execute = async () => {
			if (action === "start") await controller.start(ctx);
			else if (action === "dictate") await controller.toggleDictation(ctx);
			else if (action === "mute") controller.mute();
			else if (action === "stop") await controller.stop();
			else await phone(ctx);
		};
		void execute().catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
	};
	const actions = () =>
		controller.active
			? [
					{ value: "mute" as const, label: controller.muted ? "Unmute" : "Mute" },
					{ value: "stop" as const, label: "Stop voice" },
				]
			: controller.recording
				? [
						{ value: "dictate" as const, label: "Finish dictation" },
						{ value: "stop" as const, label: "Cancel dictation" },
					]
				: controller.status !== "off"
					? [{ value: "stop" as const, label: "Cancel voice" }]
					: [
							{ value: "start" as const, label: "Start voice" },
							{ value: "dictate" as const, label: "Dictate a draft" },
							{ value: "phone" as const, label: "Connect phone" },
						];
	const open = async (ctx: ExtensionContext) => {
		const action = await ctx.ui.custom<VoiceAction | undefined>(
			(tui, theme, _keys, done) =>
				new SelectBox<VoiceAction>({
					title: controller.status === "off" ? "Voice" : `Voice: ${controller.status}`,
					filterable: false,
					options: actions(),
					theme,
					onSelect: done,
					onCancel: () => done(undefined),
					requestRender: () => tui.requestRender(),
				}),
			{ overlay: true, overlayOptions: { width: 56, anchor: "center" } },
		);
		if (action) run(action, ctx);
	};
	controller.onChange = () => {
		const label = controller.recording ? "Dictation" : "Voice";
		const status = controller.muted ? "muted" : controller.status;
		context?.ui.setStatus(
			"pi-voice",
			controller.status === "off"
				? undefined
				: `${label}: ${status} · ${controlsKey ?? "Voice controls"} to ${controller.recording ? "finish or cancel" : "mute or stop"}`,
		);
	};
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("before_agent_start", (_event, ctx) => {
		context = ctx;
	});
	const disposers = (["start", "dictate", "mute", "stop", "phone"] as const).map((action) =>
		registerAction({ id: `voice.${action}`, description: `Voice ${action}`, run: (ctx) => run(action, ctx) }),
	);
	disposers.push(registerAction({ id: "voice.open", description: "Open voice controls", run: open }));
	pi.registerCommand("voice", {
		description: "Voice controls: start, dictate, mute, stop, phone",
		handler: async (args, ctx) => {
			const action = args.trim() || "start";
			if (!["start", "dictate", "mute", "stop", "phone"].includes(action)) {
				ctx.ui.notify("Voice actions: start, dictate, mute, stop, phone", "info");
				return;
			}
			run(action as VoiceAction, ctx);
		},
	});
	return () => {
		controller.onChange = () => {};
		context?.ui.setStatus("pi-voice", undefined);
		for (const dispose of disposers) dispose();
	};
}
