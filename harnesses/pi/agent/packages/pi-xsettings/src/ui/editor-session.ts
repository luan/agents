import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import type { DialogHost } from "pi-libtui";
import { configuredPiValues, piSettingDefinitions, syncPiSettingsJson } from "../config/pi-settings.ts";
import { setPath, type SettingsRecord, type XSettingsStore } from "../config/store.ts";
import type { SettingRegistration, SettingValue, XSettingsRegistry } from "../protocol/settings.ts";
import { applyLiveTheme, applySavedSettings } from "../runtime/apply.ts";
import { publishAllSettings, resolveRegistrationValues } from "../runtime/settings.ts";
import { storedEnumValue, toUiField } from "./fields.ts";
import { type SettingsScreenField, XSettingsScreen } from "./xsettings-screen.ts";

/** One open settings editor, including its serialized writes and close-time apply. */
export class XSettingsEditorSession {
	private settingsChanged = false;
	private reloadRequired = false;
	private pendingWrite = Promise.resolve();

	private constructor(
		private readonly context: ExtensionContext,
		private readonly store: XSettingsStore,
		private readonly registry: XSettingsRegistry,
		private document: SettingsRecord,
		private readonly fields: readonly SettingsScreenField[],
		private readonly modelOptions: readonly { value: string | number; label: string; description: string }[],
	) {}

	static async create(
		pi: ExtensionAPI,
		context: ExtensionContext,
		store: XSettingsStore,
		registry: XSettingsRegistry,
	): Promise<XSettingsEditorSession> {
		const document = await store.load();
		const piDefinitions = piSettingDefinitions(pi, context);
		const registrations = Object.values(registry.registrations).filter(
			(value): value is SettingRegistration => value !== undefined,
		);
		const registrationValues = new Map(
			registrations.map((registration) => [registration.namespace, resolveRegistrationValues(registration, document)]),
		);
		const fields = [
			...piDefinitions.map((definition) => toUiField(document, undefined, definition)),
			...registrations.flatMap((registration) =>
				registration.definitions.map((definition) =>
					toUiField(document, registration, definition, registrationValues.get(registration.namespace)),
				),
			),
		];
		const enabledModels = piDefinitions.find((definition) => definition.key === "enabledModels");
		return new XSettingsEditorSession(
			context,
			store,
			registry,
			document,
			fields,
			enabledModels?.type === "multi-enum" ? enabledModels.options : [],
		);
	}

	createScreen(
		tui: TUI,
		theme: Theme,
		onClose: () => void,
		options: { readonly heightOffset: number; readonly dialogHost?: DialogHost; readonly sidebarToggleKey?: KeyId },
	): XSettingsScreen {
		return new XSettingsScreen(
			this.fields,
			theme,
			(id, value) => {
				const definition = this.fields.find((field) => field.id === id);
				if (!definition) return;
				let storedValue = value;
				if (definition.type === "enum") {
					if (typeof value !== "string") return;
					storedValue = storedEnumValue(definition, value);
				}
				if (
					definition.id === "pi.theme" &&
					typeof storedValue === "string" &&
					!applyLiveTheme(this.context, storedValue)
				)
					return;
				this.persist(definition, () => this.store.set(definition.storagePath, storedValue));
			},
			(id) => {
				const definition = this.fields.find((field) => field.id === id);
				if (!definition) return;
				if (
					definition.id === "pi.theme" &&
					typeof definition.defaultValue === "string" &&
					!applyLiveTheme(this.context, definition.defaultValue)
				)
					return;
				this.persist(definition, () => this.store.unset(definition.storagePath));
			},
			onClose,
			() => Math.max(6, tui.terminal.rows - options.heightOffset),
			this.modelOptions,
			undefined,
			options.dialogHost,
			() => tui.requestRender(),
			options.sidebarToggleKey,
			(id, value) => this.preview(id, value),
		);
	}

	async finish(): Promise<void> {
		await this.pendingWrite;
		await applySavedSettings(this.context, this.settingsChanged, this.reloadRequired);
	}

	private persist(definition: SettingsScreenField, write: () => Promise<SettingsRecord>): void {
		this.settingsChanged = true;
		this.reloadRequired ||= definition.apply !== "live";
		this.pendingWrite = this.pendingWrite.then(async () => {
			this.document = await write();
			await publishAllSettings(this.registry, this.document);
			await syncPiSettingsJson(configuredPiValues(this.document));
		});
	}

	private preview(id: string, value: SettingValue): void {
		const definition = this.fields.find((field) => field.id === id);
		if (!definition || (definition.id !== "pi.theme" && definition.apply !== "live")) return;
		let storedValue = value;
		if (definition.type === "enum") {
			if (typeof value !== "string") return;
			storedValue = storedEnumValue(definition, value);
		}
		if (definition.id === "pi.theme") {
			if (typeof storedValue === "string") applyLiveTheme(this.context, storedValue);
			return;
		}
		const namespace = definition.storagePath[1];
		const registration = namespace ? this.registry.registrations[namespace] : undefined;
		if (!registration) return;
		const previewDocument = structuredClone(this.document);
		setPath(previewDocument, definition.storagePath, storedValue);
		void this.registry.publish(namespace, resolveRegistrationValues(registration, previewDocument));
	}
}
