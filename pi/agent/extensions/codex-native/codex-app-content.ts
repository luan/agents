function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function humanizeIdentifier(value: string): string {
	const words = value
		.replace(/^_+/, "")
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

export function codexAppTextContentToText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	try {
		return structuredContentToText(JSON.parse(trimmed));
	} catch {
		return text;
	}
}

export function structuredContentToText(value: unknown): string {
	if (!isRecord(value)) return JSON.stringify(value, null, 2);
	for (const key of ["messages", "message", "content", "text", "markdown"]) {
		if (typeof value[key] === "string" && value[key].trim().length > 0) {
			const footer = typeof value.pagination_info === "string" ? `\n\n${value.pagination_info}` : "";
			return `${value[key]}${footer}`;
		}
	}

	const textPairs = Object.entries(value).filter(
		([, entryValue]) => typeof entryValue === "string" && entryValue.trim().length > 0,
	);
	if (textPairs.length > 0 && textPairs.length <= 4) {
		return textPairs.map(([key, entryValue]) => `${humanizeIdentifier(key)}:\n${entryValue}`).join("\n\n");
	}

	return JSON.stringify(value, null, 2);
}
