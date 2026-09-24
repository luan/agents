import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import type { DialogHost } from "@luan.sh/pi-libtui";
import { piSettingDefinitions } from "../config/pi-settings.ts";
import type { SettingsEdit, SettingsSyncResult } from "../config/pi-settings-sync.ts";
import { type SettingsRecord, setPath } from "../config/store.ts";
import type { SettingRegistration, SettingValue, XSettingsRegistry } from "../protocol/settings.ts";
import { applyLiveTheme, applySavedSettings } from "../runtime/apply.ts";
import { resolveRegistrationValues } from "../runtime/settings.ts";
import { storedEnumValue, toUiField } from "./fields.ts";
import { type SettingsScreenField, XSettingsScreen } from "./xsettings-screen.ts";

/** One open settings editor, including its serialized writes and close-time apply. */
export class XSettingsEditorSession {
	private settingsChanged = false;
	private reloadRequired = false;
	private pendingWrite = Promise.resolve();

	private constructor(
		private readonly context: ExtensionContext,
		private readonly reconcile: (edit?: SettingsEdit) => Promise<SettingsSyncResult>,
		private readonly registry: XSettingsRegistry,
		private document: SettingsRecord,
		private readonly fields: readonly SettingsScreenField[],
		private readonly modelOptions: readonly { value: string | number; label: string; description: string }[],
	) {}

	static async create(
		pi: ExtensionAPI,
		context: ExtensionContext,
		reconcile: (edit?: SettingsEdit) => Promise<SettingsSyncResult>,
		registry: XSettingsRegistry,
	): Promise<XSettingsEditorSession> {
		const { document } = await reconcile();
		const piDefinitions = piSettingDefinitions(pi, context);
		const registrations = Object.values(registry.registrations).filter(
			(value): value is SettingRegistration => value !== undefined,
		);
		const registrationValues = new Map(
			registrations.map((registration) => [
				registration.namespace,
				resolveRegistrationValues(registration, document, true),
			]),
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
			reconcile,
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
		options: {
			readonly heightOffset: number;
			readonly dialogHost?: DialogHost;
			readonly sidebarToggleKey?: KeyId;
			readonly requestRender: () => void;
		},
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
				this.persist(definition, storedValue);
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
				this.persist(definition, undefined);
			},
			onClose,
			() => Math.max(6, tui.terminal.rows - options.heightOffset),
			this.modelOptions,
			undefined,
			options.dialogHost,
			options.requestRender,
			options.sidebarToggleKey,
			(id, value) => this.preview(id, value),
		);
	}

	async finish(): Promise<void> {
		await this.pendingWrite;
		await applySavedSettings(this.context, this.settingsChanged, this.reloadRequired);
	}

	private persist(definition: SettingsScreenField, value: SettingValue | undefined): void {
		this.pendingWrite = this.pendingWrite
			.then(async () => {
				const result = await this.reconcile({ path: definition.storagePath, value });
				this.document = result.document;
				this.settingsChanged = true;
				this.reloadRequired ||= definition.apply !== "live";
			})
			.catch((error: Error) => {
				this.context.ui.notify(`Could not save settings: ${error.message}`, "error");
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
		if (
			registration.definitions.some(
				(item) => item.scope === "session" && item.key === definition.storagePath.slice(2).join("."),
			)
		)
			return;
		const previewDocument = structuredClone(this.document);
		setPath(previewDocument, definition.storagePath, storedValue);
		void this.registry.publish(namespace, resolveRegistrationValues(registration, previewDocument));
	}
}
