import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureActionsRegistry, loadActionKeybindings } from "pi-libactions/sdk";
import {
	ensureSidePanelRegistry,
	mountScreenIconActions,
	type ScreenIconActionsMount,
	type SidePanelRegistry,
} from "pi-libtui";
import { ensureMouseRegistry } from "pi-libtui/mouse";
import { registerSidePanelActions } from "./actions.ts";
import { SidePanelController } from "./controller.ts";
import { latestSidePanelLayout, SIDE_PANEL_STATE_ENTRY_TYPE } from "./state.ts";

export default function sidePanelExtension(pi: ExtensionAPI): void {
	let panel: SidePanelController | undefined;
	let controls: ScreenIconActionsMount | undefined;
	let disposeActions: (() => void) | undefined;
	let detachHostSession: (() => void) | undefined;
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let host: ReturnType<SidePanelRegistry["installHost"]> | undefined;

	const detach = (): void => {
		// Freeze persisted layout before contributors detach their ephemeral views.
		panel?.dispose();
		panel = undefined;
		detachHostSession?.();
		detachHostSession = undefined;
		controls?.dispose();
		controls = undefined;
		disposeActions?.();
		disposeActions = undefined;
	};

	pi.on("session_start", (_event, context) => {
		if (context.mode !== "tui" || !context.hasUI || process.env.PI_EMBEDDED_SIDE_CHAT === "1") return;
		host ??= ensureSidePanelRegistry(globalThis).installHost();
		detach();
		activeSession = context.sessionManager;
		const bindings = loadActionKeybindings();
		const reportActionError = (error: unknown): void => {
			context.ui.notify(
				`Could not run side-panel action: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		};
		const controller = new SidePanelController(
			latestSidePanelLayout(context.sessionManager.getBranch()),
			(state) => pi.appendEntry(SIDE_PANEL_STATE_ENTRY_TYPE, state),
			bindings,
			{
				defer: queueMicrotask,
				executeAction(id) {
					const action = ensureActionsRegistry().find(id);
					if (!action) return;
					try {
						const pending = action.run(context);
						if (pending) void pending.catch(reportActionError);
					} catch (error) {
						reportActionError(error);
					}
				},
			},
			globalThis,
		);
		panel = controller;
		disposeActions = registerSidePanelActions(controller);
		controls = mountScreenIconActions({
			id: "pi-side-panel.controls",
			theme: context.ui.theme,
			registry: ensureMouseRegistry(),
			actions: [
				{
					value: "zoom",
					glyph: "󰘖",
					tooltip: () => (controller.isZoomed() ? "Restore side panel" : "Expand side panel"),
					shortcuts: bindings["side-panel.zoom"],
					visible: () => controller.isVisible(),
				},
				{
					value: "toggle",
					glyph: () => (controller.isVisible() ? "" : ""),
					tooltip: () => (controller.isVisible() ? "Hide side panel" : "Show side panel"),
					shortcuts: bindings["side-panel.toggle"],
				},
			],
			onActivate: (value) => {
				if (value === "zoom") controller.toggleZoom();
				else controller.toggle();
			},
		});
		detachHostSession = host.attach(context, controller, (provider, error) => {
			context.ui.notify(
				`Could not attach side-panel provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
		controller.restore();
	});

	pi.on("session_shutdown", (event, context) => {
		if (context.mode !== "tui" || !context.hasUI || activeSession !== context.sessionManager) return;
		detach();
		activeSession = undefined;
		if (event.reason === "reload" || event.reason === "quit") {
			host?.dispose();
			host = undefined;
		}
	});
}
