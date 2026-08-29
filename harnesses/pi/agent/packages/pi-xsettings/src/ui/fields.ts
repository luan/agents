import type { Component } from "@earendil-works/pi-tui";
import { getPath, type SettingsRecord } from "../config/store.ts";
import type { SettingValue } from "../protocol/settings.ts";
import { type SettingDefinition, type SettingRegistration, settingPath } from "../protocol/settings.ts";
import { resolveSettingOptions } from "../runtime/options.ts";
import { resolveSettingValue } from "../runtime/settings.ts";
import type { EnumSettingField } from "./settings-editor.ts";
import type { SettingsScreenField } from "./xsettings-screen.ts";

export class RenderLines implements Component {
	constructor(private readonly renderLines: (width: number) => string[]) {}
	handleInput(): void {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.renderLines(width);
	}
}

export function toUiField(
	document: SettingsRecord,
	registration: SettingRegistration | undefined,
	definition: SettingDefinition,
	resolvedValues: Readonly<Record<string, SettingValue>> = {},
): SettingsScreenField {
	const id = registration ? `extensions.${registration.namespace}.${definition.key}` : `pi.${definition.key}`;
	const value =
		resolvedValues[definition.key] ??
		resolveSettingValue(definition, document, registration?.namespace, resolvedValues);
	const storagePath = settingPath(definition, registration?.namespace);
	const configured = getPath(document, storagePath) !== undefined;
	const persistence = {
		page: definition.page ?? (definition.category === "appearance" ? "ui" : definition.category),
		section: definition.section ?? registration?.label ?? "General",
		apply: definition.apply ?? "reload",
		storagePath,
		configured,
		...(id === "pi.defaultTools"
			? {
					unsetLabel: "all default tools",
					emptyLabel: "none",
					unsetOnlyDefault: true,
				}
			: {}),
	};
	if (definition.type === "list") {
		return {
			...definition,
			...persistence,
			id,
			value: value as SettingValue[],
			defaultValue: definition.default,
		};
	}
	if (definition.type === "boolean") {
		return { ...definition, ...persistence, id, value: value as boolean, defaultValue: definition.default };
	}
	if (definition.type === "string") {
		return { ...definition, ...persistence, id, value: value as string, defaultValue: definition.default };
	}
	if (definition.type === "string-list") {
		return { ...definition, ...persistence, id, value: value as string[], defaultValue: definition.default };
	}
	if (definition.type === "multi-enum") {
		const options = definition.options.map(({ value: optionValue, ...option }) => ({
			...option,
			value: String(optionValue),
		}));
		const defaultValue = id === "pi.defaultTools" ? options.map((option) => option.value) : definition.default;
		return {
			...definition,
			...persistence,
			id,
			value: id === "pi.defaultTools" && !configured ? defaultValue : (value as string[]),
			defaultValue,
			options,
		};
	}
	const optionSource = "source" in definition.options ? definition.options : undefined;
	const options = resolveSettingOptions(definition.options, resolvedValues);
	return {
		...definition,
		...persistence,
		id,
		value: String(value),
		defaultValue: String(definition.default),
		options: options.map(({ value: optionValue, ...option }) => ({
			...option,
			value: String(optionValue),
		})),
		optionValues: options.map(({ value: optionValue }) => optionValue),
		...(optionSource
			? {
					optionsFrom: {
						fieldId: registration
							? `extensions.${registration.namespace}.${optionSource.setting}`
							: `pi.${optionSource.setting}`,
						itemField: optionSource.field,
					},
				}
			: {}),
	};
}

export function storedEnumValue(field: EnumSettingField, selectedValue: string): string | number {
	const index = field.options.findIndex((option) => option.value === selectedValue);
	const originalValue = index >= 0 ? field.optionValues?.[index] : undefined;
	if (originalValue !== undefined) return originalValue;
	return selectedValue;
}
