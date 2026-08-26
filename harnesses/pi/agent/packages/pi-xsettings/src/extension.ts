import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadActionKeybindings, registerAction } from "pi-libactions/sdk";
import {
	configureTuiAppearance,
	DialogOverlayHost,
	FullscreenOverlay,
	fullscreenOverlayOptions,
	offsetDialogHost,
} from "pi-libtui";
import { configuredPiValues, piSettingDefinitions, syncPiSettingsJson } from "./config/pi-settings.ts";
import { type SettingsRecord, XSettingsStore } from "./config/store.ts";
import { registerTuiSettings, tuiSettings } from "./config/tui-settings.ts";
import { ensureXSettingsRegistry, type SettingRegistration } from "./protocol/settings.ts";
import { attachActionShortcuts } from "./runtime/actions.ts";
import { applyLiveTheme, applySavedSettings } from "./runtime/apply.ts";
import { publishAllSettings, resolveRegistrationValues } from "./runtime/settings.ts";
import { storedEnumValue, toUiField } from "./ui/fields.ts";
import { type SettingsScreenField, XSettingsScreen } from "./ui/xsettings-screen.ts";

export default function xsettingsExtension(pi: ExtensionAPI): void {
	const store = new XSettingsStore();
	const registry = ensureXSettingsRegistry();
	const unregisterTuiSettings = registerTuiSettings();
	const detachShortcuts = attachActionShortcuts(pi, loadActionKeybindings());
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
		let settingsChanged = false;
		let reloadRequired = false;
		let document = await store.load();
		const piDefinitions = piSettingDefinitions(pi, ctx);
		const registrations = Object.values(registry.registrations).filter(
			(value): value is SettingRegistration => value !== undefined,
		);
		const registrationValues = new Map(
			registrations.map((registration) => [registration.namespace, resolveRegistrationValues(registration, document)]),
		);
		const fields: SettingsScreenField[] = [
			...piDefinitions.map((definition) => toUiField(document, undefined, definition)),
			...registrations.flatMap((registration) =>
				registration.definitions.map((definition) =>
					toUiField(document, registration, definition, registrationValues.get(registration.namespace)),
				),
			),
		];
		const enabledModels = piDefinitions.find((definition) => definition.key === "enabledModels");
		const modelOptions = enabledModels?.type === "multi-enum" ? enabledModels.options : [];
		let pendingWrite = Promise.resolve();
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const dialogs = new DialogOverlayHost(tui, theme);
				const persist = (definition: SettingsScreenField, write: () => Promise<SettingsRecord>): void => {
					settingsChanged = true;
					reloadRequired ||= definitionRequiresReload(definition);
					pendingWrite = pendingWrite.then(async () => {
						document = await write();
						await publishAllSettings(registry, document);
						await syncPiSettingsJson(configuredPiValues(document));
					});
				};
				const close = (): void => {
					dialogs.dispose();
					done();
				};
				const screen = new XSettingsScreen(
					fields,
					theme,
					(id, value) => {
						const definition = fields.find((field) => field.id === id);
						if (!definition) return;
						let storedValue = value;
						if (definition.type === "enum") {
							if (typeof value !== "string") return;
							storedValue = storedEnumValue(definition, value);
						}
						if (definition.id === "pi.theme" && typeof storedValue === "string" && !applyLiveTheme(ctx, storedValue))
							return;
						persist(definition, () => store.set(definition.storagePath, storedValue));
					},
					(id) => {
						const definition = fields.find((field) => field.id === id);
						if (!definition) return;
						if (
							definition.id === "pi.theme" &&
							typeof definition.defaultValue === "string" &&
							!applyLiveTheme(ctx, definition.defaultValue)
						)
							return;
						persist(definition, () => store.unset(definition.storagePath));
					},
					close,
					() => Math.max(6, tui.terminal.rows - 2),
					modelOptions,
					undefined,
					offsetDialogHost(dialogs, { row: 1, col: 1 }),
					() => tui.requestRender(),
				);
				return new FullscreenOverlay(tui, theme, screen, { label: "Settings", icon: "settings" });
			},
			{
				overlay: true,
				overlayOptions: fullscreenOverlayOptions(),
			},
		);
		await pendingWrite;
		await applySavedSettings(ctx, settingsChanged, reloadRequired);
	}

	const unregisterAction = registerAction({
		id: "xsettings.toggle",
		description: "Open extension settings",
		run: open,
	});
	pi.registerCommand("xsettings", {
		description: "Open extension settings",
		handler: async (_args, ctx) => open(ctx),
	});
	pi.on("session_start", async (_event, ctx) => {
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
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload" && event.reason !== "quit") return;
		detachShortcuts();
		detachRegistration();
		unregisterTuiSettings();
		configureTuiAppearance(tuiSettings.defaults);
		unregisterAction();
	});
}

function definitionRequiresReload(definition: SettingsScreenField): boolean {
	return !(
		definition.id === "pi.theme" ||
		definition.id === "extensions.pi-libtui.iconPack" ||
		definition.id === "extensions.pi-libtui.activityMarker" ||
		definition.id === "extensions.pi-libtui.shimmer" ||
		definition.id === "extensions.pi-libtui.shimmerMarker" ||
		definition.id === "extensions.pi-libtui.animationSpeed" ||
		definition.id === "extensions.pi-libtui.animationSmoothness" ||
		definition.id === "extensions.pi-libtui.powerline" ||
		definition.id === "extensions.pi-libtui.powerlineButtons" ||
		definition.id === "extensions.pi-libtui.softCursor"
	);
}
