import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ensureSelectionRegistry } from "pi-libtui/selection";
import { registerCopyModeAction } from "./contributions/actions.ts";
import { registerCopyModeSettings } from "./config/settings.ts";
import { createCopyModeHost, type CopyModeHost } from "./runtime/copy-mode.ts";

const WIDGET_KEY = "pi-copy-mode.host";

class CopyModeWidget implements Component {
	readonly host: CopyModeHost;

	constructor(tui: TUI, ctx: ExtensionContext) {
		this.host = createCopyModeHost(tui, ctx);
	}

	render(): string[] {
		return [];
	}
	invalidate(): void {}
	dispose(): void {
		this.host.dispose();
	}
}

export default function copyModeExtension(pi: ExtensionAPI): void {
	let host: CopyModeHost | undefined;
	let removeSelectionListener: (() => void) | undefined;
	const unregisterSettings = registerCopyModeSettings();
	const unregisterAction = registerCopyModeAction((ctx) => {
		if (ctx.mode !== "tui" || !host) {
			ctx.ui.notify("Copy mode requires an active interactive TUI session.", "warning");
			return;
		}
		host.enter();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const widget = new CopyModeWidget(tui, ctx);
			host = widget.host;
			return widget;
		});
		removeSelectionListener?.();
		removeSelectionListener = ensureSelectionRegistry().onSelectionCompleted((selection) =>
			host?.selectionCompleted(selection),
		);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		removeSelectionListener?.();
		removeSelectionListener = undefined;
		host?.dispose();
		host = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (event.reason === "reload" || event.reason === "quit") {
			unregisterAction();
			unregisterSettings();
		}
	});
}
