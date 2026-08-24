import type { SettingOption, SettingOptions, SettingValue } from "../protocol/settings.ts";

export function settingOptionsFromValue(value: SettingValue | undefined, field: string): readonly SettingOption[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const optionValue = item[field];
		return typeof optionValue === "string" || typeof optionValue === "number"
			? [{ value: optionValue, label: String(optionValue), description: "" }]
			: [];
	});
}

export function resolveSettingOptions(
	options: SettingOptions,
	values: Readonly<Record<string, SettingValue>>,
): readonly SettingOption[] {
	return "source" in options ? settingOptionsFromValue(values[options.setting], options.field) : options;
}
