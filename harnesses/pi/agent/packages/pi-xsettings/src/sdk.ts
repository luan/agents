import {
	ensureXSettingsRegistry,
	type ListDefinition,
	type SettingCategory,
	type SettingDefinition,
	type SettingOption,
	type SettingOptions,
	type SettingPage,
	type SettingPreview,
	type SettingValue,
} from "./protocol/settings.ts";
import type { Static, TSchema } from "typebox";
import { checkSchema } from "./config/schema.ts";
import { resolveSettingOptions } from "./runtime/options.ts";

export type { ListDefinition, ListItemField, SettingPage } from "./protocol/settings.ts";

interface DefinitionBase {
	label: string;
	description: string;
	category: SettingCategory;
	page?: SettingPage;
	section?: string;
	preview?: SettingPreview;
}

export interface ListSettingDefinitionInput<Schema extends TSchema = TSchema> extends DefinitionBase {
	type: "list";
	default: Static<Schema> & SettingValue[];
	schema: Schema;
	list: ListDefinition;
}

export interface StringListSettingDefinitionInput extends DefinitionBase {
	type: "string-list";
	default: readonly string[];
	minItems: number;
}

export function stringListSetting(
	definition: Omit<StringListSettingDefinitionInput, "type">,
): StringListSettingDefinitionInput {
	return { ...definition, type: "string-list" };
}

export function listSetting<const Schema extends TSchema>(
	schema: Schema,
	definition: Omit<ListSettingDefinitionInput<Schema>, "schema" | "type">,
): ListSettingDefinitionInput<Schema> {
	return { ...definition, schema, type: "list" };
}

export type SettingDefinitionInput =
	| (DefinitionBase & { type: "boolean"; default: boolean })
	| (DefinitionBase & { type: "string"; default: string })
	| StringListSettingDefinitionInput
	| (DefinitionBase & { type: "enum"; default: number | string; options: SettingOptions })
	| (DefinitionBase & {
			type: "multi-enum";
			default: readonly string[];
			options: readonly SettingOption[];
			ordered: boolean;
	  })
	| ListSettingDefinitionInput;

type OptionValue<Definition extends SettingDefinitionInput> = Definition extends {
	options: readonly (infer Option)[];
}
	? Option extends { value: infer Value extends number | string }
		? Value
		: never
	: string;

type ValueOf<Definition extends SettingDefinitionInput> = Definition extends { type: "boolean" }
	? boolean
	: Definition extends { type: "string" }
		? string
		: Definition extends { type: "string-list" }
			? string[]
			: Definition extends { type: "enum" }
				? OptionValue<Definition>
				: Definition extends { type: "multi-enum" }
					? Array<Extract<OptionValue<Definition>, string>>
					: Definition extends { type: "list"; schema: infer Schema extends TSchema }
						? Static<Schema>
						: never;

export type SettingsOf<Definitions extends Record<string, SettingDefinitionInput>> = {
	-readonly [Key in keyof Definitions]: ValueOf<Definitions[Key]>;
};

export interface SettingsClient<Definitions extends Record<string, SettingDefinitionInput>> {
	readonly defaults: Readonly<SettingsOf<Definitions>>;
	get(): SettingsOf<Definitions>;
	register(onValues?: (settings: Readonly<SettingsOf<Definitions>>) => void | Promise<void>): () => void;
}

export interface CreateSettingsOptions<Definitions extends Record<string, SettingDefinitionInput>> {
	namespace: string;
	label: string;
	definitions: Definitions;
}

export function createSettings<const Definitions extends Record<string, SettingDefinitionInput>>(
	options: CreateSettingsOptions<Definitions>,
): SettingsClient<Definitions> {
	const definitions = Object.entries(options.definitions).map(([key, definition]) =>
		toProtocolDefinition(key, definition),
	);
	const defaults = resolveValues(options.definitions, Object.create(null) as Readonly<Record<string, SettingValue>>);
	let current = cloneSettings(defaults);

	return {
		defaults,
		get: () => cloneSettings(current),
		register(onValues) {
			const unregister = ensureXSettingsRegistry().register({
				namespace: options.namespace,
				label: options.label,
				definitions,
				async onValues(values) {
					current = resolveValues(options.definitions, values);
					await onValues?.(cloneSettings(current));
				},
			});
			return () => {
				unregister();
			};
		},
	};
}

function toProtocolDefinition(key: string, definition: SettingDefinitionInput): SettingDefinition {
	if (definition.type === "list") {
		if (!validValue(definition, definition.default)) {
			throw new Error(`Invalid default for list setting "${key}".`);
		}
		return {
			...definition,
			key,
			default: cloneValue(definition.default),
		};
	}
	if (definition.type === "string-list") {
		const defaultValue = [...definition.default];
		if (!validValue(definition, defaultValue)) {
			throw new Error(`Invalid default for string-list setting "${key}".`);
		}
		return { ...definition, key, default: defaultValue };
	}
	return {
		...definition,
		key,
		...(definition.type === "multi-enum" ? { default: [...definition.default] } : {}),
	} as SettingDefinition;
}

function resolveValues<Definitions extends Record<string, SettingDefinitionInput>>(
	definitions: Definitions,
	values: Readonly<Record<string, SettingValue>>,
): SettingsOf<Definitions> {
	const resolved: Record<string, SettingValue> = Object.create(null) as Record<string, SettingValue>;
	for (const [key, definition] of Object.entries(definitions)) {
		if (definition.type === "enum" && !Array.isArray(definition.options)) continue;
		resolved[key] = resolveValue(definition, values[key], resolved);
	}
	for (const [key, definition] of Object.entries(definitions)) {
		if (definition.type !== "enum" || Array.isArray(definition.options)) continue;
		resolved[key] = resolveValue(definition, values[key], resolved);
	}
	return resolved as SettingsOf<Definitions>;
}

function resolveValue(
	definition: SettingDefinitionInput,
	value: SettingValue | undefined,
	values: Readonly<Record<string, SettingValue>>,
): SettingValue {
	if (definition.type === "list") {
		return validValue(definition, value) ? cloneValue(value) : cloneValue(definition.default);
	}
	switch (definition.type) {
		case "boolean":
			return typeof value === "boolean" ? value : definition.default;
		case "string":
			return typeof value === "string" ? value : definition.default;
		case "string-list":
			return Array.isArray(value) &&
				value.length >= definition.minItems &&
				value.every((entry) => typeof entry === "string")
				? ([...value] as string[])
				: [...definition.default];
		case "enum": {
			const options = resolveSettingOptions(definition.options, values);
			return (typeof value === "string" || typeof value === "number") &&
				options.some((option) => option.value === value)
				? value
				: options.some((option) => option.value === definition.default)
					? definition.default
					: (options[0]?.value ?? definition.default);
		}
		case "multi-enum": {
			const allowed = new Set(
				definition.options.flatMap((option) => (typeof option.value === "string" ? [option.value] : [])),
			);
			return Array.isArray(value) && value.every((entry) => typeof entry === "string")
				? value.filter((entry) => allowed.has(entry))
				: [...definition.default];
		}
	}
}

function validValue(definition: SettingDefinitionInput, value: SettingValue | undefined): value is SettingValue {
	if (value === undefined) return false;
	if (definition.type === "list") return Array.isArray(value) && checkSchema(definition.schema, value);
	if (definition.type === "boolean") return typeof value === "boolean";
	if (definition.type === "string") return typeof value === "string";
	if (definition.type === "string-list") {
		return (
			Array.isArray(value) &&
			Number.isInteger(definition.minItems) &&
			definition.minItems >= 0 &&
			value.length >= definition.minItems &&
			value.every((entry) => typeof entry === "string")
		);
	}
	if (definition.type === "multi-enum") {
		const allowed = new Set(
			definition.options.flatMap((option) => (typeof option.value === "string" ? [option.value] : [])),
		);
		return Array.isArray(value) && value.every((entry) => typeof entry === "string" && allowed.has(entry));
	}
	if (!Array.isArray(definition.options)) return typeof value === "string" || typeof value === "number";
	return (
		(typeof value === "string" || typeof value === "number") &&
		definition.options.some((option) => option.value === value)
	);
}

function cloneSettings<Definitions extends Record<string, SettingDefinitionInput>>(
	settings: SettingsOf<Definitions>,
): SettingsOf<Definitions> {
	return Object.fromEntries(
		Object.entries(settings).map(([key, value]) => [key, cloneValue(value)]),
	) as SettingsOf<Definitions>;
}

function cloneValue<Value extends SettingValue>(value: Value): Value {
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as Value;
	if (typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])) as Value;
	}
	return value;
}
