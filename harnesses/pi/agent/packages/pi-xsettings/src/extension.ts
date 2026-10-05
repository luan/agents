import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadActionKeybindings, registerAction } from "@luan.sh/pi-libactions/sdk";
import {
	configureTuiAppearance,
	DialogOverlayHost,
	FullscreenOverlay,
	fullscreenOverlayOptions,
	offsetDialogHost,
	registerSidePanelProvider,
	type SidePanelSession,
} from "@luan.sh/pi-libtui";
import { PiSettingsSync, type SettingsEdit, type SettingsSyncResult } from "./config/pi-settings-sync.ts";
import {
	DEFAULT_XSETTINGS_PRESENTATION_SETTINGS,
	registerXSettingsPresentationSettings,
} from "./config/presentation.ts";
import { XSettingsStore } from "./config/store.ts";
import { registerTuiSettings, tuiSettings } from "./config/tui-settings.ts";
import { ensureXSettingsRegistry } from "./protocol/settings.ts";
import { attachActionShortcuts } from "./runtime/actions.ts";
import { registerEffortActions } from "./runtime/effort.ts";
import {
	isSessionSetting,
	publishSessionSettings,
	SESSION_SETTING_ENTRY,
	sessionSettingRecord,
	sessionSettingsDocument,
} from "./runtime/session-settings.ts";
import { publishAllSettings, resolveRegistrationValues } from "./runtime/settings.ts";
import { watchSettings } from "./runtime/settings-watch.ts";
import { applyConfiguredTools } from "./runtime/tool-selection.ts";
import { XSettingsEditorSession } from "./ui/editor-session.ts";
import type { SettingsScreenLocation, XSettingsScreen } from "./ui/xsettings-screen.ts";

const SETTINGS_TAB_ID = "pi-xsettings.settings";
const NAVIGATION_KEY = Symbol.for("pi-xsettings/navigation/v1");

interface NavigationMemory {
	location?: SettingsScreenLocation;
}

// Only this package writes this versioned slot. Keep navigation, never runtime contexts, across reloads.
function settingsNavigationMemory(): NavigationMemory {
	const host = globalThis as typeof globalThis & { [NAVIGATION_KEY]?: NavigationMemory };
	host[NAVIGATION_KEY] ??= {};
	return host[NAVIGATION_KEY];
}

export default function xsettingsExtension(pi: ExtensionAPI): void {
	const store = new XSettingsStore();
	const sync = new PiSettingsSync(store.path);
	let stopWatching: (() => void) | undefined;
	let disposed = false;
	let syncContext: ExtensionContext | undefined;
	let syncNotice: string | undefined;
	let lastNotified: string | undefined;
	const registry = ensureXSettingsRegistry();
	const unregisterTuiSettings = registerTuiSettings();
	let presentation = DEFAULT_XSETTINGS_PRESENTATION_SETTINGS.presentation;
	let panel: SidePanelSession | undefined;
	let panelContext: ExtensionContext | undefined;
	let panelEditor: XSettingsEditorSession | undefined;
	let panelTabOpen = false;
	let removeEmptyAction: (() => void) | undefined;
	let unregisterSidePanelProvider: (() => void) | undefined;
	let activeScreen: XSettingsScreen | undefined;
	const navigation = settingsNavigationMemory();
	function releaseScreen(screen = activeScreen): void {
		if (!screen || screen !== activeScreen) return;
		navigation.location = screen.getLocation();
		activeScreen = undefined;
	}
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
	void initialization.catch((error: Error) => reportSync(`Could not initialize xsettings: ${error.message}`));
	const pendingRegistrations = new Set<Promise<void>>();

	function reportSync(message: string | undefined): void {
		syncNotice = message;
		if (message && message !== lastNotified && syncContext?.hasUI) {
			syncContext.ui.notify(message, "warning");
			lastNotified = message;
		}
		if (!message) lastNotified = undefined;
	}

	async function reconcile(edit?: SettingsEdit, context = syncContext): Promise<SettingsSyncResult> {
		const sessionEdit = edit && isSessionSetting(registry, edit.path);
		if (sessionEdit) {
			if (!context || context.sessionManager.getSessionId() !== syncContext?.sessionManager.getSessionId())
				throw new Error("Settings session changed before the edit was saved");
			pi.appendEntry(SESSION_SETTING_ENTRY, sessionSettingRecord(edit));
		}
		const result = await sync.reconcile(sessionEdit ? undefined : edit);
		if (disposed) return result;
		await publishAllSettings(registry, result.document);
		if (disposed) return result;
		reportSync(
			result.conflicts.length > 0
				? `Settings conflict: ${result.conflicts.join(", ")}. Both files were preserved for these settings. Choose a value in /xsettings or make both files agree.`
				: undefined,
		);
		if (!context) return result;
		const document = sessionSettingsDocument(registry, result.document, context.sessionManager.getBranch());
		publishSessionSettings(registry, context.sessionManager.getSessionId(), document);
		return { ...result, document };
	}

	async function initialize(): Promise<void> {
		await store.load();
		if (disposed) return;
		stopWatching = watchSettings(
			[store.path, sync.jsonPath],
			async () => {
				await reconcile();
			},
			(error) => reportSync(`Could not synchronize settings: ${error.message}`),
		);
		try {
			await reconcile();
		} catch (error) {
			reportSync(`Could not synchronize settings: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const detachRegistration = registry.onRegister((registration) => {
		const pending = initialization.then(async () => {
			const document = await store.load();
			if (disposed) return;
			await registry.publish(registration.namespace, resolveRegistrationValues(registration, document));
			if (!disposed && syncContext)
				publishSessionSettings(
					registry,
					syncContext.sessionManager.getSessionId(),
					sessionSettingsDocument(registry, document, syncContext.sessionManager.getBranch()),
				);
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
		if (disposed) return;
		if (presentation === "side-panel" && panel) {
			if (panelTabOpen) {
				panel.activate(SETTINGS_TAB_ID);
				panel.show({ focus: true });
				return;
			}
			panelEditor = await XSettingsEditorSession.create(pi, ctx, (edit) => reconcile(edit, ctx), registry);
			panelTabOpen = true;
			panel.addTab(
				{
					id: SETTINGS_TAB_ID,
					label: "Settings",
					icon: "settings",
					create: (host, theme) => {
						const screen = panelEditor!.createScreen(host.tui, theme, closePanelEditor, {
							heightOffset: 1,
							requestRender: () => host.requestRender(),
							sidebarToggleKey,
							location: navigation.location,
							onDispose: releaseScreen,
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
		const editor = await XSettingsEditorSession.create(pi, ctx, (edit) => reconcile(edit, ctx), registry);
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const dialogs = new DialogOverlayHost(tui, theme);
				const close = (): void => {
					releaseScreen();
					dialogs.dispose();
					done();
				};
				const screen = editor.createScreen(tui, theme, close, {
					heightOffset: 2,
					requestRender: () => tui.requestRender(),
					dialogHost: offsetDialogHost(dialogs, { row: 1, col: 1 }),
					sidebarToggleKey,
					location: navigation.location,
					onDispose: releaseScreen,
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
		releaseScreen();
		panelTabOpen = false;
		panel?.removeTab(SETTINGS_TAB_ID);
		finishPanelEditor();
	}

	function finishPanelEditor(): void {
		if (!panelEditor) return;
		releaseScreen();
		panelTabOpen = false;
		const editor = panelEditor;
		panelEditor = undefined;
		if (disposed) return;
		void editor.finish().catch((error) => {
			panelContext?.ui.notify(
				`Could not apply settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
	}

	let unregisterAction: (() => void) | undefined;
	let unregisterEffort: (() => void) | undefined;
	let unregisterCursorAction: (() => void) | undefined;
	pi.registerCommand("xsettings", {
		description: "Open extension settings",
		handler: async (_args, ctx) => open(ctx),
	});
	pi.on("session_start", async (_event, ctx) => {
		syncContext = ctx;
		await initialization;
		await settleRegistrations();
		if (disposed) return;
		await reconcile();
		if (disposed) return;
		applyConfiguredTools(pi);
		reportSync(syncNotice);
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		panelContext = ctx;
		unregisterEffort?.();
		unregisterEffort = registerEffortActions(pi);
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
	pi.on("session_tree", () => applyConfiguredTools(pi));
	pi.on("before_agent_start", async (_event, ctx) => {
		const stored = await store.load();
		if (disposed) return;
		const document = sessionSettingsDocument(registry, stored, ctx.sessionManager.getBranch());
		publishSessionSettings(registry, ctx.sessionManager.getSessionId(), document);
	});
	pi.on("session_shutdown", async (_event, context) => {
		// Every shutdown replaces this runtime; invalidate captures before yielding.
		disposed = true;
		releaseScreen();
		syncContext = undefined;
		panelContext = undefined;
		stopWatching?.();
		stopWatching = undefined;
		if (registry.sessionValues) delete registry.sessionValues[context.sessionManager.getSessionId()];
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = undefined;
		closePanelEditor();
		panel = undefined;
		detachShortcuts();
		detachRegistration();
		unregisterTuiSettings();
		unregisterPresentationSettings();
		configureTuiAppearance(tuiSettings.defaults);
		unregisterAction?.();
		unregisterAction = undefined;
		unregisterEffort?.();
		unregisterEffort = undefined;
		unregisterCursorAction?.();
		unregisterCursorAction = undefined;
		await initialization;
		await sync.reconcile();
	});
}
