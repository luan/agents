import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectReport } from "./runtime/collect-report.ts";
import { ReportScreen } from "./ui/report-screen.ts";
import { ToolControlService } from "./runtime/tool-controls.ts";
import { DialogOverlayHost, FullscreenOverlay, fullscreenOverlayOptions } from "@luan.sh/pi-libtui";
export default function tokenBurden(pi: ExtensionAPI): void {
	pi.registerCommand("token-burden", {
		description: "Open read-only token burden report",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			const report = collectReport(pi, ctx);
			const controls = new ToolControlService({
				getAllTools: () => pi.getAllTools().map((tool) => ({ name: tool.name })),
				getActiveTools: () => pi.getActiveTools(),
				setActiveTools: (names) => pi.setActiveTools(names),
				waitForIdle: () => ctx.waitForIdle(),
			});
			await ctx.ui.custom(
				(tui, theme, keybindings, done) => {
					const dialogs = new DialogOverlayHost(tui, theme);
					const screen = new ReportScreen(report, {
						theme,
						keybindings,
						requestRender: () => tui.requestRender(),
						height: () => Math.max(1, tui.terminal.rows - 2),
						close: () => {
							screen.dispose();
							dialogs.dispose();
							done(undefined);
						},
						dialogs,
						toolControls: controls,
					});
					return new FullscreenOverlay(tui, theme, screen, "Token burden");
				},
				{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
			);
		},
	});
}
