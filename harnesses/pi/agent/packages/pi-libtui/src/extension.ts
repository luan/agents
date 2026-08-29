import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Color256Preview } from "./color/preview.ts";
import { claimLibtuiExtensionHost } from "./host/extension-host.ts";
import { FullscreenOverlay, fullscreenOverlayOptions } from "./overlay/fullscreen.ts";
import { registerRequestAnimation } from "./request-animation.ts";

export default function libtuiExtension(pi: ExtensionAPI): void {
	const host = claimLibtuiExtensionHost(pi);
	if (!host) return;
	registerRequestAnimation(pi);
	pi.registerCommand("libtui:colors", {
		description: "Show the active terminal's 256-color palette",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/libtui:colors requires the interactive TUI.", "warning");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new FullscreenOverlay(tui, theme, new Color256Preview(theme, done), "256 colors · Esc or q to close"),
				{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
			);
		},
	});
	pi.on("session_start", (_event, ctx) => host.start(ctx));
	pi.on("session_shutdown", async (event, ctx) => {
		await host.shutdown(ctx, event.reason === "reload");
		if (event.reason === "reload" || event.reason === "quit") host.release();
	});
}
