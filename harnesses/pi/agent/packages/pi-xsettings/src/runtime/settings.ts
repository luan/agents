import { checkSchema } from "../config/schema.ts";
import { getPath, type SettingsRecord, type StoredSettingValue } from "../config/store.ts";
import type { SettingDefinition, SettingRegistration, SettingValue, XSettingsRegistry } from "../protocol/settings.ts";
import { settingPath } from "../protocol/settings.ts";
import { resolveSettingOptions } from "./options.ts";

function validSettingValue(
	definition: SettingDefinition,
	value: StoredSettingValue | undefined,
): value is SettingValue {
	if (definition.type === "boolean") return typeof value === "boolean";
	if (definition.type === "string") return typeof value === "string";
	if (definition.type === "string-list") {
		return (
			Array.isArray(value) &&
			Number.isInteger(definition.minItems) &&
			definition.minItems >= 0 &&
			value.length >= definition.minItems &&
			value.every((item) => typeof item === "string")
		);
	}
	if (definition.type === "multi-enum") return Array.isArray(value) && value.every((item) => typeof item === "string");
	if (definition.type === "list")
		return Array.isArray(value) && isSettingValue(value) && checkSchema(definition.schema, value);
	if (!Array.isArray(definition.options)) return typeof value === "string" || typeof value === "number";
	return (
		(typeof value === "string" || typeof value === "number") &&
		definition.options.some((option) => option.value === value)
	);
}

function isSettingValue(value: StoredSettingValue | undefined): value is SettingValue {
	if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return true;
	if (Array.isArray(value)) return value.every((entry) => isSettingValue(entry));
	if (!value || typeof value !== "object" || value instanceof Date) return false;
	return Object.values(value).every((entry) => isSettingValue(entry));
}

export function resolveRegistrationValues(
	registration: SettingRegistration,
	document: SettingsRecord,
): Record<string, SettingValue> {
	const values: Record<string, SettingValue> = Object.create(null) as Record<string, SettingValue>;
	for (const definition of registration.definitions) {
		if (definition.type === "enum" && !Array.isArray(definition.options)) continue;
		values[definition.key] = resolveSettingValue(definition, document, registration.namespace, values);
	}
	for (const definition of registration.definitions) {
		if (definition.type !== "enum" || Array.isArray(definition.options)) continue;
		values[definition.key] = resolveSettingValue(definition, document, registration.namespace, values);
	}
	return values;
}

export function resolveSettingValue(
	definition: SettingDefinition,
	document: SettingsRecord,
	namespace?: string,
	values: Readonly<Record<string, SettingValue>> = {},
): SettingValue {
	const configured = getPath(document, settingPath(definition, namespace));
	if (definition.type !== "enum") return validSettingValue(definition, configured) ? configured : definition.default;
	const options = resolveSettingOptions(definition.options, values);
	if (
		(typeof configured === "string" || typeof configured === "number") &&
		options.some((option) => option.value === configured)
	)
		return configured;
	if (options.some((option) => option.value === definition.default)) return definition.default;
	return options[0]?.value ?? definition.default;
}

export async function publishAllSettings(registry: XSettingsRegistry, document: SettingsRecord): Promise<void> {
	for (const registration of Object.values(registry.registrations)) {
		if (registration) await registry.publish(registration.namespace, resolveRegistrationValues(registration, document));
	}
}
