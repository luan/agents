import { runCommand } from "./ct-runner.ts";

export type LensReadRange = {
	cwd: string;
	path: string;
	startLine: number;
	endLine: number;
	session?: string;
	signal?: AbortSignal;
};

export async function recordLensRead(range: LensReadRange): Promise<void> {
	if (!range.path || !Number.isFinite(range.startLine) || !Number.isFinite(range.endLine)) return;
	const startLine = Math.max(1, Math.trunc(range.startLine));
	const endLine = Math.max(startLine, Math.trunc(range.endLine));
	const args = ["lens", "read", "record", "--path", range.path, "--start-line", String(startLine), "--end-line", String(endLine), "--json"];
	if (range.session) args.push("--session", range.session);
	try {
		await runCommand("ct", args, range.cwd, range.signal);
	} catch {
		return;
	}
}

export async function recordLensReadsFromAstMatches(parsed: unknown, cwd: string, session?: string, signal?: AbortSignal): Promise<void> {
	const ranges = exactRanges(parsed);
	for (const range of ranges) await recordLensRead({ cwd, session, signal, ...range });
}

function exactRanges(value: unknown): Array<{ path: string; startLine: number; endLine: number }> {
	const out: Array<{ path: string; startLine: number; endLine: number }> = [];
	visit(value, (item) => {
		const path = stringField(item, ["file", "path", "filePath", "filename"]);
		if (!path) return;
		const range = rangeFrom(item);
		if (range) out.push({ path, ...range });
	});
	return out;
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

function rangeFrom(item: Record<string, unknown>): { startLine: number; endLine: number } | undefined {
	if (typeof item.startLine === "number" && typeof item.endLine === "number") {
		return { startLine: item.startLine, endLine: item.endLine };
	}
	const range = item.range as any;
	if (typeof range?.start?.line === "number" && typeof range?.end?.line === "number") {
		return { startLine: Math.max(1, range.start.line + 1), endLine: Math.max(1, range.end.line + 1) };
	}
}
