export const LENS_TOOL_NAMES = [
	"lens_discover",
	"lens_guard",
	"lens_diagnostics",
	"lens_health",
	"lens_cleanup",
	"lens_report",
	"lens_context",
] as const;

export type LensSeverity = "clean" | "warning" | "blocked" | "degraded" | "error" | "unknown";

type LensRecord = Record<string, any>;

export function lensSeverity(value: unknown): LensSeverity {
	const data = asRecord(value);
	const decision = lower(data?.decision?.outcome);
	if (decision === "block") return "blocked";
	const health = lower(data?.health?.status ?? data?.data?.status ?? data?.status);
	if (health === "blocked") return "blocked";
	if (health === "error") return "error";
	if (health === "degraded") return "degraded";
	if (health === "warning") return "warning";
	if (health === "clean") return "clean";
	const envelopeStatus = lower(data?.status);
	if (envelopeStatus === "error") return "error";
	if (envelopeStatus === "warning") return "warning";
	if (hasItems(data?.errors)) return "error";
	if (hasItems(data?.warnings)) return "warning";
	return envelopeStatus === "ok" ? "clean" : "unknown";
}

export function renderLensCompactStatus(value: unknown): string {
	const data = asRecord(value);
	const severity = lensSeverity(data);
	const icon = severityIcon(severity);
	const parts = [`󰛩 Lens ${icon} ${severity}`];
	const compact = stringValue(data?.health?.compact ?? data?.data?.compact ?? data?.compact);
	if (compact) parts.push(compact);
	const diagnostics = diagnosticsSummary(data);
	if (diagnostics) parts.push(diagnostics);
	const guard = guardSummary(data);
	if (guard) parts.push(guard);
	const cleanup = cleanupSummary(data);
	if (cleanup) parts.push(cleanup);
	const patch = patchSummary(data);
	if (patch) parts.push(patch);
	const errors = messages(data?.errors, 1);
	if (errors.length > 0) parts.push(errors[0]!);
	return parts.join(" · ");
}

export function renderLensWidgetLines(value: unknown, expanded = false): string[] {
	const data = asRecord(value);
	const lines = [renderLensCompactStatus(data)];
	const actionContext = asRecord(data?.context ?? data?.data?.action_context ?? data?.data?.health?.action_context ?? data?.data);
	const actions = actionLines(data, actionContext);
	if (!expanded && actions.length > 0) {
		lines.push(...actions.slice(0, 3));
		if (actions.length > 3) lines.push(`  … ${actions.length - 3} more Lens action(s)`);
		return lines;
	}
	if (expanded) {
		lines.push(...messageLines("warning", data?.warnings));
		lines.push(...messageLines("error", data?.errors));
		lines.push(...actions);
		const jsonRefs = referenceLines(data);
		if (jsonRefs.length > 0) lines.push(...jsonRefs);
	}
	return lines;
}

export function summarizeLensResult(result: unknown, expanded = false): string {
	const data = asRecord(result);
	const envelope = asRecord(data?.details?.results ?? data?.results ?? data);
	const lines = renderLensWidgetLines(envelope, expanded);
	if (expanded) return lines.join("\n");
	return lines[0] ?? "󰛩 Lens unknown";
}

function actionLines(data: LensRecord | undefined, actionContext: LensRecord | undefined): string[] {
	const out: string[] = [];
	const required = actionContext?.required === true || lensSeverity(data) !== "clean";
	if (required && stringValue(actionContext?.instructions)) out.push(`  action: ${actionContext.instructions}`);
	const remediation = Array.isArray(actionContext?.remediation) ? actionContext.remediation : [];
	for (const item of remediation) if (typeof item === "string" && item) out.push(`  fix: ${item}`);
	const ack = stringValue(actionContext?.ack_command);
	if (ack) out.push(`  ack: ${ack}`);

	const summary = asRecord(data?.data?.health?.summary ?? data?.data?.summary ?? data?.health?.details);
	const guard = asRecord(summary?.guard);
	if ((guard?.blocked ?? 0) > 0) out.push(`  guard: read required ranges before editing (${guard.blocked} blocked)`);
	if ((guard?.warnings ?? 0) > 0) out.push(`  guard: ${guard.warnings} warning decision(s) need review`);
	const cleanup = asRecord(summary?.cleanup);
	if ((cleanup?.failed ?? 0) > 0 || (cleanup?.timed_out ?? 0) > 0) out.push(`  cleanup: inspect ${cleanup.failed ?? 0} failed/${cleanup.timed_out ?? 0} timed-out run(s)`);
	const diagnostics = asRecord(summary?.diagnostics ?? data?.diagnostics);
	if ((diagnostics?.errors ?? 0) > 0 || (diagnostics?.warnings ?? 0) > 0) out.push(`  diagnostics: resolve ${diagnostics.errors ?? 0} error(s), ${diagnostics.warnings ?? 0} warning(s)`);
	const patch = asRecord(summary?.patch_refs);
	if ((patch?.draft_refs ?? 0) > 0 || (patch?.hunks ?? 0) > 0 || (patch?.accepted_events ?? 0) > 0) out.push(`  patch: inspect telemetry refs (${patch.draft_refs ?? 0} drafts, ${patch.hunks ?? 0} hunks, ${patch.accepted_events ?? 0} accepts)`);
	return [...new Set(out)];
}

function referenceLines(data: LensRecord | undefined): string[] {
	const refs = new Set<string>();
	collect(data, (item) => {
		const raw = item.raw_output_ref ?? item.raw_output_id;
		if (typeof raw === "number" || typeof raw === "string") refs.add(`raw:${raw}`);
		const draft = item.draft_ref ?? item.draft_id ?? item.patch_draft_id;
		if (typeof draft === "number" || typeof draft === "string") refs.add(`draft:${draft}`);
	});
	return refs.size > 0 ? [`  refs: ${[...refs].join(", ")}`] : [];
}

function diagnosticsSummary(data: LensRecord | undefined): string | undefined {
	const summary = asRecord(data?.data?.health?.summary?.diagnostics ?? data?.data?.summary?.diagnostics ?? data?.diagnostics ?? data?.data?.health?.diagnostics);
	const active = numberValue(summary?.active ?? summary?.total ?? data?.data?.diagnostic_count);
	const errors = numberValue(summary?.errors);
	const warnings = numberValue(summary?.warnings);
	if (active === undefined && errors === undefined && warnings === undefined) return undefined;
	return `diag ${active ?? (errors ?? 0) + (warnings ?? 0)} (${errors ?? 0} err/${warnings ?? 0} warn)`;
}

function guardSummary(data: LensRecord | undefined): string | undefined {
	const guard = asRecord(data?.data?.health?.summary?.guard ?? data?.data?.summary?.guard);
	const blocked = numberValue(guard?.blocked);
	const warnings = numberValue(guard?.warnings);
	if ((blocked ?? 0) > 0) return `guard ${blocked} blocked`;
	if ((warnings ?? 0) > 0) return `guard ${warnings} warn`;
	const decisions = Array.isArray(data?.decision?.guard) ? data?.decision?.guard : [];
	if (decisions.length > 0) return `guard ${decisions.length} decision(s)`;
}

function cleanupSummary(data: LensRecord | undefined): string | undefined {
	const cleanup = asRecord(data?.data?.health?.summary?.cleanup ?? data?.data?.summary?.cleanup);
	const runs = numberValue(cleanup?.runs);
	const failed = numberValue(cleanup?.failed);
	const timedOut = numberValue(cleanup?.timed_out);
	if (runs === undefined && failed === undefined && timedOut === undefined) return undefined;
	return `cleanup ${runs ?? 0} run/${failed ?? 0} failed/${timedOut ?? 0} timeout`;
}

function patchSummary(data: LensRecord | undefined): string | undefined {
	const patch = asRecord(data?.data?.health?.summary?.patch_refs ?? data?.data?.summary?.patch_refs);
	const drafts = numberValue(patch?.draft_refs);
	const hunks = numberValue(patch?.hunks);
	const accepts = numberValue(patch?.accepted_events);
	if ((drafts ?? 0) === 0 && (hunks ?? 0) === 0 && (accepts ?? 0) === 0) return undefined;
	return `patch ${drafts ?? 0} drafts/${hunks ?? 0} hunks/${accepts ?? 0} accepts`;
}

function messageLines(kind: string, value: unknown): string[] {
	return messages(value, 3).map((message) => `  ${kind}: ${message}`);
}

function messages(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => stringValue(item?.message ?? item?.code ?? item))
		.filter((item): item is string => !!item)
		.slice(0, limit);
}

function collect(value: unknown, each: (item: LensRecord) => void) {
	if (Array.isArray(value)) {
		for (const item of value) collect(item, each);
		return;
	}
	const item = asRecord(value);
	if (!item) return;
	each(item);
	for (const child of Object.values(item)) if (child && typeof child === "object") collect(child, each);
}

function severityIcon(severity: LensSeverity): string {
	switch (severity) {
		case "clean":
			return "✓";
		case "warning":
			return "⚠";
		case "blocked":
			return "⛔";
		case "degraded":
			return "◌";
		case "error":
			return "✗";
		default:
			return "?";
	}
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
