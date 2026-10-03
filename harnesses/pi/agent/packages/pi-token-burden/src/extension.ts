import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectReport } from "./runtime/collect-report.ts";
import { ReportScreen } from "./ui/report-screen.ts";
import { ToolControlService } from "./runtime/tool-controls.ts";
import { DialogOverlayHost } from "@luan.sh/pi-libtui";
export default function tokenBurden(pi: ExtensionAPI): void {
	pi.registerCommand("token-burden", {
		description: "Inspect token burden and active tools",
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
						height: () => Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.9))),
						close: () => {
							screen.dispose();
							dialogs.dispose();
							done(undefined);
						},
						dialogs,
						toolControls: controls,
					});
					return screen;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: 80, maxHeight: "90%", margin: 1 } },
			);
		},
	});
}
