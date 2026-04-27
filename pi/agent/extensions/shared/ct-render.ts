import { Text } from "@mariozechner/pi-tui";

type RenderContext = { lastComponent?: { setText(value: string): void } };

export function renderText(ctx: RenderContext, value: string) {
	const text = ctx.lastComponent ?? new Text("", 0, 0);
	text.setText(value);
	return text;
}

export function toolResult(result: unknown): Record<string, unknown> {
	return (((result as any)?.details as any)?.results ?? {}) as Record<string, unknown>;
}

export function firstLocations(value: unknown, limit = 3): string[] {
	const out: string[] = [];
	visit(value, (item) => {
		if (out.length >= limit) return;
		const path = stringField(item, ["file", "path", "filePath", "filename"]);
		const uri = stringField(item, ["uri", "targetUri"]);
		const file = path ?? uriToPath(uri);
		const line = lineFrom(item);
		if (file) out.push(line ? `${file}:${line}` : file);
	});
	return [...new Set(out)].slice(0, limit);
}

export function resultCount(data: Record<string, unknown>): number {
	const count = data.resultCount ?? data.result_count ?? data.match_count ?? data.diagnostic_count;
	return typeof count === "number" ? count : Array.isArray(data.matches) ? data.matches.length : 0;
}

function visit(value: unknown, each: (item: Record<string, unknown>) => void) {
	if (Array.isArray(value)) {
		for (const item of value) visit(item, each);
		return;
	}
	if (!value || typeof value !== "object") return;
	const item = value as Record<string, unknown>;
	each(item);
	for (const child of Object.values(item)) {
		if (child && typeof child === "object") visit(child, each);
	}
}

function stringField(item: Record<string, unknown>, names: string[]): string | undefined {
	for (const name of names) {
		const value = item[name];
		if (typeof value === "string" && value.length > 0) return value;
	}
}

function lineFrom(item: Record<string, unknown>): number | undefined {
	for (const key of ["line", "startLine"]) {
		const value = item[key];
		if (typeof value === "number") return Math.max(1, Math.trunc(value));
	}
	const range = item.range as any;
	const start = range?.start ?? item.start;
	if (typeof start?.line === "number") return Math.max(1, Math.trunc(start.line + 1));
}

function uriToPath(uri: string | undefined): string | undefined {
	if (!uri) return undefined;
	if (!uri.startsWith("file://")) return uri;
	try {
		return decodeURIComponent(uri.slice("file://".length));
	} catch {
		return uri.slice("file://".length);
	}
}
