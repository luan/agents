import type { TuiForegroundColor } from "pi-libtui";
import type { TSchema } from "typebox";

export const XSETTINGS_REGISTRY_KEY = Symbol.for("pi-xsettings/registry/v1");
export const XSETTINGS_PROTOCOL = "pi-xsettings/registry/v1" as const;

export type SettingCategory = "appearance" | "behavior" | "interaction" | "tools";
export type SettingPage = "ui" | "ux" | "animations" | "terminal" | "behavior" | "interaction" | "tools";
export type SettingPreview =
	| "activity-marker"
	| "activity-message"
	| "status-presentation"
	| "text-effect"
	| "pulse-effect"
	| "animation-speed"
	| "animation-smoothness";
export type SettingApply = "live" | "reload";
export type SettingValue = boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

export interface SettingOption {
	value: number | string;
	label: string;
	description: string;
	color?: TuiForegroundColor;
}

export type SettingOptions =
	| readonly SettingOption[]
	| {
			source: "setting";
			setting: string;
			field: string;
	  };

export type ListFieldOptions = readonly SettingOption[] | { source: "models" };

interface ListItemFieldBase {
	key: string;
	label: string;
	description: string;
	shortcut?: string;
}

export type ListItemField =
	| (ListItemFieldBase & { type: "boolean" })
	| (ListItemFieldBase & { type: "string" })
	| (ListItemFieldBase & { type: "enum"; options: ListFieldOptions })
	| (ListItemFieldBase & { type: "list"; list: ListDefinition });

export interface ListSummaryColumn {
	path: readonly (number | string)[];
	color?: TuiForegroundColor;
	colors?: Readonly<Record<string, TuiForegroundColor>>;
}

export interface ListIdentityColor {
	path: readonly (number | string)[];
	colors: Readonly<Record<string, TuiForegroundColor>>;
}

export interface ListDefinition {
	itemLabel: string;
	identity: string;
	uniqueIdentity: boolean;
	identityColor?: ListIdentityColor;
	summary: readonly ListSummaryColumn[];
	minItems: number;
	newItem: { [key: string]: SettingValue };
	fields: readonly ListItemField[];
}

interface SettingDefinitionBase {
	key: string;
	label: string;
	description: string;
	category: SettingCategory;
	page?: SettingPage;
	section?: string;
	preview?: SettingPreview;
	apply?: SettingApply;
}

export type SettingDefinition =
	| (SettingDefinitionBase & { type: "boolean"; default: boolean })
	| (SettingDefinitionBase & { type: "string"; default: string })
	| (SettingDefinitionBase & { type: "string-list"; default: string[]; minItems: number })
	| (SettingDefinitionBase & { type: "enum"; default: number | string; options: SettingOptions })
	| (SettingDefinitionBase & {
			type: "multi-enum";
			default: string[];
			options: readonly SettingOption[];
			ordered: boolean;
	  })
	| (SettingDefinitionBase & {
			type: "list";
			default: SettingValue[];
			schema: TSchema;
			list: ListDefinition;
	  });

export function settingPath(definition: SettingDefinition, namespace?: string): string[] {
	return [definition.category, namespace ?? "pi", ...definition.key.split(".")];
}

export interface SettingRegistration {
	namespace: string;
	label: string;
	definitions: readonly SettingDefinition[];
	onValues?: (values: Readonly<Record<string, SettingValue>>) => void | Promise<void>;
}

export interface XSettingsRegistry {
	protocol: typeof XSETTINGS_PROTOCOL;
	version: 1;
	registrations: Record<string, SettingRegistration | undefined>;
	values: Record<string, Readonly<Record<string, SettingValue>> | undefined>;
	listeners: Array<(registration: SettingRegistration) => void>;
	register(registration: SettingRegistration): () => void;
	publish(namespace: string, values: Readonly<Record<string, SettingValue>>): Promise<void>;
	onRegister(listener: (registration: SettingRegistration) => void): () => void;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; isRegistry validates the structure.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is XSettingsRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<XSettingsRegistry>;
	return (
		candidate.protocol === XSETTINGS_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.register === "function" &&
		typeof candidate.publish === "function" &&
		typeof candidate.onRegister === "function"
	);
}

export function ensureXSettingsRegistry(scope: typeof globalThis = globalThis): XSettingsRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[XSETTINGS_REGISTRY_KEY];
	if (isRegistry(existing)) return existing;
	const registry: XSettingsRegistry = {
		protocol: XSETTINGS_PROTOCOL,
		version: 1,
		registrations: Object.create(null) as Record<string, SettingRegistration | undefined>,
		values: Object.create(null) as Record<string, Readonly<Record<string, SettingValue>> | undefined>,
		listeners: [],
		register(registration) {
			registry.registrations[registration.namespace] = registration;
			for (const listener of [...registry.listeners]) listener(registration);
			const values = registry.values[registration.namespace];
			if (values) void registration.onValues?.(values);
			return () => {
				if (registry.registrations[registration.namespace] === registration) {
					delete registry.registrations[registration.namespace];
				}
			};
		},
		async publish(namespace, values) {
			registry.values[namespace] = Object.freeze({ ...values });
			await registry.registrations[namespace]?.onValues?.(registry.values[namespace]!);
		},
		onRegister(listener) {
			registry.listeners.push(listener);
			return () => {
				const index = registry.listeners.indexOf(listener);
				if (index >= 0) registry.listeners.splice(index, 1);
			};
		},
	};
	slots[XSETTINGS_REGISTRY_KEY] = registry;
	return registry;
}
