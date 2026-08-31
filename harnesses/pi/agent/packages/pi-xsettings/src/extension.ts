import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadActionKeybindings, registerAction } from "pi-libactions/sdk";
import {
	configureTuiAppearance,
	DialogOverlayHost,
	FullscreenOverlay,
	fullscreenOverlayOptions,
	offsetDialogHost,
	registerSidePanelProvider,
	type SidePanelSession,
} from "pi-libtui";
import { configuredPiValues, syncPiSettingsJson } from "./config/pi-settings.ts";
import {
	DEFAULT_XSETTINGS_PRESENTATION_SETTINGS,
	registerXSettingsPresentationSettings,
} from "./config/presentation.ts";
import { XSettingsStore } from "./config/store.ts";
import { registerTuiSettings, tuiSettings } from "./config/tui-settings.ts";
import { ensureXSettingsRegistry } from "./protocol/settings.ts";
import { attachActionShortcuts } from "./runtime/actions.ts";
import { publishAllSettings, resolveRegistrationValues } from "./runtime/settings.ts";
import { XSettingsEditorSession } from "./ui/editor-session.ts";
import type { XSettingsScreen } from "./ui/xsettings-screen.ts";

const SETTINGS_TAB_ID = "pi-xsettings.settings";

export default function xsettingsExtension(pi: ExtensionAPI): void {
	const store = new XSettingsStore();
	const registry = ensureXSettingsRegistry();
	const unregisterTuiSettings = registerTuiSettings();
	let presentation = DEFAULT_XSETTINGS_PRESENTATION_SETTINGS.presentation;
	let panel: SidePanelSession | undefined;
	let panelContext: ExtensionContext | undefined;
	let panelEditor: XSettingsEditorSession | undefined;
	let panelTabOpen = false;
	let removeEmptyAction: (() => void) | undefined;
	let unregisterSidePanelProvider: (() => void) | undefined;
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let activeScreen: XSettingsScreen | undefined;
	const unregisterPresentationSettings = registerXSettingsPresentationSettings((settings) => {
		presentation = settings.presentation;
		if (presentation === "fullscreen") closePanelEditor();
	});
	const actionKeybindings = loadActionKeybindings();
	const sidebarToggleKey = actionKeybindings["xsettings.cursor.toggle"]?.[0];
	const shortcutBindings = { ...actionKeybindings };
	// Tab is contextual inside the settings screen; Pi rejects it as a global
	// extension shortcut because the editor already owns that key.
	delete shortcutBindings["xsettings.cursor.toggle"];
	const detachShortcuts = attachActionShortcuts(pi, shortcutBindings);
	const initialization = initialize();
	const pendingRegistrations = new Set<Promise<void>>();

	async function initialize(): Promise<void> {
		const document = await store.load();
		await publishAllSettings(registry, document);
		await syncPiSettingsJson(configuredPiValues(document));
	}

	const detachRegistration = registry.onRegister((registration) => {
		const pending = initialization.then(async () => {
			const document = await store.load();
			await registry.publish(registration.namespace, resolveRegistrationValues(registration, document));
		});
		pendingRegistrations.add(pending);
		void pending.catch(() => undefined);
	});

	async function settleRegistrations(): Promise<void> {
		while (pendingRegistrations.size > 0) {
			const pending = [...pendingRegistrations];
			try {
				await Promise.all(pending);
			} finally {
				for (const registration of pending) pendingRegistrations.delete(registration);
			}
		}
	}

	async function open(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/xsettings requires the interactive TUI.", "warning");
			return;
		}
		await initialization;
		await settleRegistrations();
		if (presentation === "side-panel" && panel) {
			if (panelTabOpen) {
				panel.activate(SETTINGS_TAB_ID);
				panel.show({ focus: true });
				return;
			}
			panelEditor = await XSettingsEditorSession.create(pi, ctx, store, registry);
			panelTabOpen = true;
			panel.addTab(
				{
					id: SETTINGS_TAB_ID,
					label: "Settings",
					icon: "settings",
					create: (host, theme) => {
						const screen = panelEditor!.createScreen(host.tui, theme, closePanelEditor, {
							heightOffset: 1,
							sidebarToggleKey,
						});
						activeScreen = screen;
						return screen;
					},
					onClose: finishPanelEditor,
				},
				{ activate: true, focus: true },
			);
			return;
		}
		const editor = await XSettingsEditorSession.create(pi, ctx, store, registry);
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const dialogs = new DialogOverlayHost(tui, theme);
				const close = (): void => {
					activeScreen = undefined;
					dialogs.dispose();
					done();
				};
				const screen = editor.createScreen(tui, theme, close, {
					heightOffset: 2,
					dialogHost: offsetDialogHost(dialogs, { row: 1, col: 1 }),
					sidebarToggleKey,
				});
				activeScreen = screen;
				return new FullscreenOverlay(tui, theme, screen, { label: "Settings", icon: "settings" });
			},
			{
				overlay: true,
				overlayOptions: fullscreenOverlayOptions(),
			},
		);
		await editor.finish();
	}

	function closePanelEditor(): void {
		if (!panelTabOpen) return;
		activeScreen = undefined;
		panelTabOpen = false;
		panel?.removeTab(SETTINGS_TAB_ID);
		finishPanelEditor();
	}

	function finishPanelEditor(): void {
		if (!panelEditor) return;
		activeScreen = undefined;
		panelTabOpen = false;
		const editor = panelEditor;
		panelEditor = undefined;
		void editor.finish().catch((error) => {
			panelContext?.ui.notify(
				`Could not apply settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
	}

	let unregisterAction: (() => void) | undefined;
	let unregisterCursorAction: (() => void) | undefined;
	pi.registerCommand("xsettings", {
		description: "Open extension settings",
		handler: async (_args, ctx) => open(ctx),
	});
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		panelContext = ctx;
		activeSession = ctx.sessionManager;
		unregisterAction?.();
		unregisterAction = registerAction({
			id: "xsettings.toggle",
			description: "Open extension settings",
			run: open,
		});
		unregisterCursorAction?.();
		unregisterCursorAction = registerAction({
			id: "xsettings.cursor.toggle",
			description: "Toggle focus between the settings sidebar and content",
			run: () => activeScreen?.toggleCursor(),
		});
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = registerSidePanelProvider(
			{
				id: "pi-xsettings.settings",
				session: ctx,
				attach(nextPanel) {
					panel = nextPanel;
					removeEmptyAction = nextPanel.registerEmptyAction({
						id: "xsettings.toggle",
						label: "Settings",
						actionId: "xsettings.toggle",
					});
					return () => {
						if (panel !== nextPanel) return;
						removeEmptyAction?.();
						removeEmptyAction = undefined;
						closePanelEditor();
						panel = undefined;
					};
				},
			},
			globalThis,
		);
		try {
			await initialization;
			await settleRegistrations();
		} catch (error) {
			ctx.ui.notify(
				`Could not load xsettings.toml: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});
	pi.on("session_shutdown", (event, context) => {
		if (context.mode !== "tui" || !context.hasUI || activeSession !== context.sessionManager) return;
		if (event.reason !== "reload" && event.reason !== "quit") return;
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = undefined;
		closePanelEditor();
		panel = undefined;
		panelContext = undefined;
		activeSession = undefined;
		detachShortcuts();
		detachRegistration();
		unregisterTuiSettings();
		unregisterPresentationSettings();
		configureTuiAppearance(tuiSettings.defaults);
		unregisterAction?.();
		unregisterAction = undefined;
		unregisterCursorAction?.();
		unregisterCursorAction = undefined;
	});
}
