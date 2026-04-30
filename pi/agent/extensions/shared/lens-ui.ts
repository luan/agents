export type LensSeverity = "clean" | "warnings" | "errors";

type LensRecord = Record<string, any>;
type LensRenderOptions = { ansi?: boolean };

type SourceSummary = {
	name: string;
	connected: boolean;
	errors: number;
	warnings: number;
};

const ansi = {
	reset: "\x1b[0m",
	lens: "\x1b[2;38;5;111m",
	muted: "\x1b[2;38;5;103m",
	separator: "\x1b[2;38;5;60m",
	clean: "\x1b[2;38;5;108m",
	warnings: "\x1b[2;38;5;179m",
	errors: "\x1b[2;38;5;203m",
	diagnostics: "\x1b[2;38;5;181m",
	fix: "\x1b[2;38;5;114m",
};

export function lensSeverity(value: unknown): LensSeverity {
	const data = asRecord(value);
	const sources = sourceSummaries(data);
	if (sources.some((source) => source.errors > 0)) return "errors";
	if (sources.some((source) => source.warnings > 0)) return "warnings";
	if (hasItems(data?.errors)) return "errors";
	if (hasItems(data?.warnings)) return "warnings";

	const status = lower(data?.health?.status ?? data?.data?.health ?? data?.data?.status ?? data?.status);
	if (status === "error" || status === "errors") return "errors";
	if (status === "warning" || status === "warnings") return "warnings";
	return "clean";
}

export function renderLensCompactStatus(value: unknown, options: LensRenderOptions = {}): string {
	const data = asRecord(value);
	const severity = lensSeverity(data);
	const style = options.ansi === true;
	const parts = [
		`${paint("lens", "󰛩 Lens", style)} ${paint(severity, `${severityIcon(severity)} ${severity}`, style)}`,
	];
	const sources = sourceSummaries(data);
	if (sources.length > 0) {
		parts.push(paint("muted", `sources: ${sources.map(formatSourceConnection).join(" ")}`, style));
		for (const source of sources) {
			if (source.errors > 0 || source.warnings > 0) {
				parts.push(paint("diagnostics", `${source.name} ${source.errors} err/${source.warnings} warn`, style));
			}
		}
	}
	const messages = messageTexts(data?.errors, 1);
	if (messages.length > 0) parts.push(paint("errors", messages[0]!, style));
	return parts.join(paint("separator", " · ", style));
}

export function renderLensWidgetLines(value: unknown, expanded = false, options: LensRenderOptions = {}): string[] {
	const data = asRecord(value);
	const style = options.ansi === true;
	const lines = [renderLensCompactStatus(data, options)];
	if (!expanded) return lines;

	for (const source of sourceSummaries(data)) {
		lines.push(colorDetailLine(`  source: ${source.name} ${source.connected ? "connected" : "unavailable"}`, style));
		if (source.errors > 0 || source.warnings > 0) {
			lines.push(
				colorDetailLine(
					`  diagnostics: ${source.name} ${source.errors} error(s), ${source.warnings} warning(s)`,
					style,
				),
			);
		}
	}
	lines.push(...messageLines("warning", data?.warnings).map((line) => colorDetailLine(line, style)));
	lines.push(...messageLines("error", data?.errors).map((line) => colorDetailLine(line, style)));
	for (const diagnostic of diagnostics(data)) {
		const path = stringValue(diagnostic.path ?? diagnostic.rel_path);
		const source = stringValue(diagnostic.source) ?? "diagnostic";
		const severity = stringValue(diagnostic.severity) ?? "warning";
		const line = numberValue(diagnostic.start_line ?? diagnostic.line);
		const location = path ? `${path}${line ? `:${line}` : ""}` : source;
		lines.push(colorDetailLine(`  diagnostics: [${source}/${severity}] ${location}: ${diagnostic.message}`, style));
		const fix = stringValue(diagnostic.fix_command ?? diagnostic.fix_instructions);
		if (fix) lines.push(colorDetailLine(`  fix: ${fix}`, style));
	}
	return [...new Set(lines)];
}

function sourceSummaries(data: LensRecord | undefined): SourceSummary[] {
	const raw =
		data?.data?.sources ??
		data?.sources ??
		data?.data?.summary?.sources ??
		data?.summary?.sources ??
		data?.health?.details?.sources;
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): SourceSummary | undefined => {
			const record = asRecord(item);
			const name = stringValue(record?.name ?? record?.source ?? record?.id);
			if (!record || !name) return undefined;
			const errors =
				numberValue(record.errors) ??
				(lower(record.status) === "errors" || lower(record.status) === "error" ? 1 : 0);
			const warnings =
				numberValue(record.warnings) ??
				(lower(record.status) === "warnings" || lower(record.status) === "warning" ? 1 : 0);
			return {
				name,
				connected: record.connected !== false && lower(record.status) !== "unavailable",
				errors,
				warnings,
			};
		})
		.filter((item): item is SourceSummary => item !== undefined);
}

function diagnostics(data: LensRecord | undefined): LensRecord[] {
	const raw = data?.data?.diagnostics ?? data?.diagnostics ?? data?.data?.issues ?? data?.issues;
	return Array.isArray(raw) ? raw.filter((item): item is LensRecord => !!asRecord(item)) : [];
}

function formatSourceConnection(source: SourceSummary): string {
	return `${source.name} ${source.connected ? "✓" : "×"}`;
}

function messageLines(kind: string, value: unknown): string[] {
	return messageTexts(value, 3).map((message) => `  ${kind}: ${message}`);
}

function messageTexts(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => stringValue(item?.message ?? item?.code ?? item))
		.filter((item): item is string => !!item)
		.slice(0, limit);
}

function severityIcon(severity: LensSeverity): string {
	switch (severity) {
		case "clean":
			return "✓";
		case "warnings":
			return "⚠";
		case "errors":
			return "✗";
	}
}

function colorDetailLine(line: string, style: boolean): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("error:")) return paint("errors", line, style);
	if (trimmed.startsWith("warning:")) return paint("warnings", line, style);
	if (trimmed.startsWith("fix:")) return paint("fix", line, style);
	if (trimmed.startsWith("diagnostics:")) return paint("diagnostics", line, style);
	return paint("muted", line, style);
}

function paint(role: keyof typeof ansi, text: string, style: boolean): string {
	return style ? `${ansi[role]}${text}${ansi.reset}` : text;
}

function asRecord(value: unknown): LensRecord | undefined {
	return value && typeof value === "object" ? (value as LensRecord) : undefined;
}

function lower(value: unknown): string | undefined {
	return typeof value === "string" ? value.toLowerCase() : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasItems(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}
