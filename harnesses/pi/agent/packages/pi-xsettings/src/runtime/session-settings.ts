import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { deletePath, setPath, type SettingsRecord } from "../config/store.ts";
import type { SettingsEdit } from "../config/pi-settings-sync.ts";
import { settingPath, type SettingValue, type XSettingsRegistry } from "../protocol/settings.ts";
import { resolveRegistrationValues } from "./settings.ts";

export const SESSION_SETTING_ENTRY = "pi-xsettings/session-setting/v1";
interface SessionSetting {
	version: 1;
	path: string[];
	value?: SettingValue;
}
// type-boundary: Pi JSONL custom records; validate the record and closed setting value before projection.
type SavedValue = unknown;
function settingValue(value: SavedValue): value is SettingValue {
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(settingValue);
	return !!value && typeof value === "object" && Object.values(value).every(settingValue);
}
function savedSetting(value: SavedValue): value is SessionSetting {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<SessionSetting>;
	return (
		entry.version === 1 &&
		Array.isArray(entry.path) &&
		entry.path.length >= 3 &&
		entry.path.every(
			(part) => typeof part === "string" && part !== "__proto__" && part !== "constructor" && part !== "prototype",
		) &&
		(entry.value === undefined || settingValue(entry.value))
	);
}
export function isSessionSetting(registry: XSettingsRegistry, path: readonly string[]): boolean {
	const registration = registry.registrations[path[1] ?? ""];
	return (
		registration?.definitions.some(
			(definition) =>
				definition.scope === "session" &&
				JSON.stringify(settingPath(definition, registration.namespace)) === JSON.stringify(path),
		) ?? false
	);
}
export function sessionSettingsDocument(
	registry: XSettingsRegistry,
	document: SettingsRecord,
	entries: readonly SessionEntry[],
): SettingsRecord {
	const result = structuredClone(document);
	for (const registration of Object.values(registry.registrations)) {
		for (const definition of registration?.definitions ?? []) {
			if (definition.scope === "session") deletePath(result, settingPath(definition, registration!.namespace));
		}
	}
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== SESSION_SETTING_ENTRY ||
			!savedSetting(entry.data) ||
			!isSessionSetting(registry, entry.data.path)
		)
			continue;
		if (entry.data.value === undefined) deletePath(result, entry.data.path);
		else setPath(result, entry.data.path, entry.data.value);
	}
	return result;
}
export function publishSessionSettings(registry: XSettingsRegistry, sessionId: string, document: SettingsRecord): void {
	const namespaces: Record<string, Readonly<Record<string, SettingValue>>> = Object.create(null);
	for (const registration of Object.values(registry.registrations)) {
		if (!registration) continue;
		const values = resolveRegistrationValues(registration, document, true);
		namespaces[registration.namespace] = Object.fromEntries(
			registration.definitions
				.filter((definition) => definition.scope === "session")
				.map((definition) => [definition.key, values[definition.key]!]),
		);
	}
	registry.sessionValues ??= Object.create(null) as NonNullable<XSettingsRegistry["sessionValues"]>;
	registry.sessionValues[sessionId] = namespaces;
}
export function sessionSettingRecord(edit: SettingsEdit): SessionSetting {
	return { version: 1, path: [...edit.path], ...(edit.value === undefined ? {} : { value: edit.value }) };
}
