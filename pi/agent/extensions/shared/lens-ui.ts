export const LENS_TOOL_NAMES = [
  "lens_status",
  "lens_health",
  "lens_touched",
  "lens_diagnostics",
  "lens_checks",
  "lens_cleanup",
  "lens_report",
  "lens_context",
  "lens_raw_output",
  "lens_prune",
] as const;

export type LensSeverity =
  | "pending"
  | "clean"
  | "warning"
  | "degraded"
  | "error"
  | "unknown";

type LensRecord = Record<string, any>;
type LensRenderOptions = { ansi?: boolean };

const ansi = {
  reset: "\x1b[0m",
  lens: "\x1b[2;38;5;111m",
  muted: "\x1b[2;38;5;103m",
  separator: "\x1b[2;38;5;60m",
  clean: "\x1b[2;38;5;108m",
  warning: "\x1b[2;38;5;179m",
  degraded: "\x1b[2;38;5;104m",
  error: "\x1b[2;38;5;203m",
  diagnostics: "\x1b[2;38;5;181m",
  cleanup: "\x1b[2;38;5;109m",
  patch: "\x1b[2;38;5;140m",
  action: "\x1b[2;38;5;116m",
  fix: "\x1b[2;38;5;114m",
  ack: "\x1b[2;38;5;147m",
};

export function lensSeverity(value: unknown): LensSeverity {
  const data = asRecord(value);
  const decision = lower(data?.decision?.outcome);
  if (decision === "block") return "warning";
  const health = lower(
    data?.health?.status ?? data?.data?.status ?? data?.status,
  );
  if (health === "blocked") return "warning";
  if (health === "pending" || health === "collecting" || health === "running")
    return "pending";
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

export function renderLensCompactStatus(
  value: unknown,
  options: LensRenderOptions = {},
): string {
  const data = asRecord(value);
  const severity = lensSeverity(data);
  const icon = severityIcon(severity);
  const style = options.ansi === true;
  const parts = [
    `${paint("lens", "󰛩 Lens", style)} ${paint(severityColor(severity), `${icon} ${severity}`, style)}`,
  ];
  const compact = stringValue(
    data?.health?.compact ?? data?.data?.compact ?? data?.compact,
  );
  if (compact && !hasHealthSummary(data))
    parts.push(paint("muted", compact, style));
  const diagnostics = diagnosticsSummary(data);
  if (diagnostics) parts.push(paint("diagnostics", diagnostics, style));
  const checks = checksSummary(data);
  if (checks) parts.push(paint("diagnostics", checks, style));
  const progress = progressSummary(data);
  if (progress) parts.push(paint("action", progress, style));
  const cleanup = cleanupSummary(data);
  if (cleanup) parts.push(paint("cleanup", cleanup, style));
  const patch = patchSummary(data);
  if (patch) parts.push(paint("patch", patch, style));
  const lsp = lspSummary(data);
  if (lsp) parts.push(paint("muted", lsp, style));
  const errors = messages(data?.errors, 1);
  if (errors.length > 0) parts.push(paint("error", errors[0]!, style));
  return parts.join(paint("separator", " · ", style));
}

export function renderLensWidgetLines(
  value: unknown,
  expanded = false,
  options: LensRenderOptions = {},
): string[] {
  const data = asRecord(value);
  const style = options.ansi === true;
  const lines = [renderLensCompactStatus(data, options)];
  const actionContext = asRecord(
    data?.context ??
      data?.data?.action_context ??
      data?.data?.health?.action_context ??
      data?.data,
  );
  const progress = progressLines(data).map((line) =>
    colorDetailLine(line, style),
  );
  const actions = actionLines(data, actionContext).map((line) =>
    colorDetailLine(line, style),
  );
  if (!expanded) return lines;
  if (expanded) {
    lines.push(
      ...messageLines("warning", data?.warnings).map((line) =>
        colorDetailLine(line, style),
      ),
    );
    lines.push(
      ...messageLines("error", data?.errors).map((line) =>
        colorDetailLine(line, style),
      ),
    );
    lines.push(...progress);
    lines.push(...actions);
    const jsonRefs = referenceLines(data);
    if (jsonRefs.length > 0)
      lines.push(...jsonRefs.map((line) => colorDetailLine(line, style)));
  }
  return lines;
}

export function summarizeLensResult(
  result: unknown,
  expanded = false,
  options: LensRenderOptions = {},
): string {
  const data = asRecord(result);
  const envelope = asRecord(data?.details?.results ?? data?.results ?? data);
  const lines = renderLensWidgetLines(envelope, expanded, options);
  if (expanded) return lines.join("\n");
  return lines[0] ?? "󰛩 Lens unknown";
}

function actionLines(
  data: LensRecord | undefined,
  actionContext: LensRecord | undefined,
): string[] {
  const out: string[] = [];
  const required = actionContext?.required === true;
  if (required && stringValue(actionContext?.instructions))
    out.push(`  action: ${actionContext.instructions}`);
  if (required) {
    const remediation = Array.isArray(actionContext?.remediation)
      ? actionContext.remediation
      : [];
    for (const item of remediation)
      if (typeof item === "string" && item) out.push(`  fix: ${item}`);
    const ack = stringValue(actionContext?.ack_command);
    if (ack) out.push(`  ack: ${ack}`);
  }

  const summary = asRecord(
    data?.data?.health?.summary ?? data?.data?.summary ?? data?.health?.details,
  );
  const cleanup = asRecord(summary?.cleanup);
  if ((cleanup?.failed ?? 0) > 0 || (cleanup?.timed_out ?? 0) > 0)
    out.push(
      `  cleanup: inspect ${cleanup.failed ?? 0} failed/${cleanup.timed_out ?? 0} timed-out run(s)`,
    );
  const diagnostics = asRecord(summary?.diagnostics ?? data?.diagnostics);
  if ((diagnostics?.errors ?? 0) > 0 || (diagnostics?.warnings ?? 0) > 0)
    out.push(
      `  diagnostics: resolve ${diagnostics.errors ?? 0} error(s), ${diagnostics.warnings ?? 0} warning(s)`,
    );
  const checks = asRecord(summary?.checks ?? data?.checks);
  const failingChecks = Array.isArray(checks?.latest)
    ? checks.latest.filter(
        (check: LensRecord) =>
          (check?.exit_code ?? 0) !== 0 || (check?.diagnostic_count ?? 0) > 0,
      ).length
    : 0;
  if (failingChecks > 0)
    out.push(
      `  checks: inspect ${failingChecks} recent check/scanner snapshot(s)`,
    );
  const patch = asRecord(summary?.patch_refs);
  if ((patch?.hunks ?? 0) > 0 || (patch?.accepted_events ?? 0) > 0)
    out.push(
      `  patch: inspect telemetry refs (${patch?.draft_refs ?? 0} drafts, ${patch.hunks ?? 0} hunks, ${patch.accepted_events ?? 0} accepts)`,
    );
  return [...new Set(out)];
}

function hasHealthSummary(data: LensRecord | undefined): boolean {
  return !!asRecord(
    data?.data?.health?.summary ?? data?.data?.summary ?? data?.health?.details,
  );
}

function referenceLines(data: LensRecord | undefined): string[] {
  const refs = new Set<string>();
  collect(data, (item) => {
    const raw = item.raw_output_ref ?? item.raw_output_id;
    if (typeof raw === "number" || typeof raw === "string")
      refs.add(`raw:${raw}`);
    const draft = item.draft_ref ?? item.draft_id ?? item.patch_draft_id;
    if (typeof draft === "number" || typeof draft === "string")
      refs.add(`draft:${draft}`);
  });
  return refs.size > 0 ? [`  refs: ${[...refs].join(", ")}`] : [];
}

function diagnosticsSummary(data: LensRecord | undefined): string | undefined {
  const summary = asRecord(
    data?.data?.health?.summary?.diagnostics ??
      data?.data?.summary?.diagnostics ??
      data?.diagnostics ??
      data?.data?.health?.diagnostics,
  );
  const active = numberValue(
    summary?.active ?? summary?.total ?? data?.data?.diagnostic_count,
  );
  const errors = numberValue(summary?.errors);
  const warnings = numberValue(summary?.warnings);
  if (active === undefined && errors === undefined && warnings === undefined)
    return undefined;
  if ((errors ?? 0) === 0 && (warnings ?? 0) === 0) {
    return lensSeverity(data) === "pending" ? `diag ${active ?? 0}` : undefined;
  }
  return `diag ${active ?? (errors ?? 0) + (warnings ?? 0)} (${errors ?? 0} err/${warnings ?? 0} warn)`;
}

function checksSummary(data: LensRecord | undefined): string | undefined {
  const runs = turnCheckRuns(data);
  if (runs.length > 0) {
    const failed = runs.filter(
      (run) => (run?.exit_code ?? 0) !== 0 || (run?.diagnostic_count ?? 0) > 0,
    ).length;
    return failed > 0
      ? `checks ${runs.length} ran/${failed} issue`
      : `checks ${runs.length} ran`;
  }
  const checks = asRecord(
    data?.data?.health?.summary?.checks ??
      data?.data?.summary?.checks ??
      data?.checks,
  );
  const latest = Array.isArray(checks?.latest) ? checks.latest : undefined;
  if (!latest) return undefined;
  const errors = latest.filter(
    (check: LensRecord) =>
      typeof check?.exit_code === "number" &&
      check.exit_code !== 0 &&
      (check?.diagnostic_count ?? 0) > 0,
  ).length;
  const warnings = latest.filter(
    (check: LensRecord) =>
      check?.exit_code === null && (check?.diagnostic_count ?? 0) > 0,
  ).length;
  if (errors === 0 && warnings === 0) return undefined;
  return `checks ${errors} err/${warnings} warn`;
}

function progressSummary(data: LensRecord | undefined): string | undefined {
  const plan = validationPlan(data);
  if (!plan?.turn_active) return undefined;
  const queue = validationQueue(plan);
  const parts = [
    queue.length > 0 ? `queue: ${queue.join(", ")}` : "end: cleanup",
  ];
  const suggestions = arrayValue(plan.suggestions);
  if (suggestions.length > 0)
    parts.push(`suggested: ${suggestions.join(", ")}`);
  return parts.join(" · ");
}

function progressLines(data: LensRecord | undefined): string[] {
  const out: string[] = [];
  const healthSummary = asRecord(
    data?.data?.health?.summary ?? data?.data?.summary ?? data?.health?.details,
  );
  const changed = asRecord(healthSummary?.changed_files);
  const changedCount = numberValue(changed?.count);
  const plan = validationPlan(data);
  if (plan?.turn_active) {
    if (changedCount !== undefined)
      out.push(`  collecting: ${changedCount} touched file(s)`);
    const checks = arrayValue(plan.automatic_checks);
    const scanners = arrayValue(plan.automatic_scanners);
    const suggestions = arrayValue(plan.suggestions);
    const planned = [...checks, ...scanners];
    out.push(
      planned.length > 0 ? `  queue: ${planned.join(", ")}` : "  end: cleanup",
    );
    if (suggestions.length > 0)
      out.push(`  suggested: ${suggestions.join(", ")}`);
  }
  const runs = turnCheckRuns(data);
  if (runs.length > 0)
    out.push(`  checks ran: ${runs.map(formatCheckRun).join(", ")}`);
  return out;
}

function lspSummary(data: LensRecord | undefined): string | undefined {
  const lsp = asRecord(
    data?.data?.health?.summary?.lsp ?? data?.data?.summary?.lsp,
  );
  const connected = Array.isArray(lsp?.connected) ? lsp.connected : [];
  const names = connected
    .map((item) => stringValue(asRecord(item)?.name))
    .filter((name): name is string => !!name);
  if (!lsp) return undefined;
  return `lsp: ${names.length > 0 ? names.join(", ") : "none"}`;
}

function validationPlan(data: LensRecord | undefined): LensRecord | undefined {
  return asRecord(
    data?.data?.health?.summary?.validation_plan ??
      data?.data?.summary?.validation_plan ??
      data?.health?.details?.validation_plan,
  );
}

function validationQueue(plan: LensRecord): string[] {
  return [
    ...arrayValue(plan.automatic_checks),
    ...arrayValue(plan.automatic_scanners),
  ];
}

function turnCheckRuns(data: LensRecord | undefined): LensRecord[] {
  const runs = data?.data?.turn?.checks?.runs ?? data?.data?.checks?.runs;
  return Array.isArray(runs)
    ? runs.filter((run): run is LensRecord => !!asRecord(run))
    : [];
}

function formatCheckRun(run: LensRecord): string {
  const name = stringValue(run.name) ?? "check";
  const status = stringValue(run.status) ?? "unknown";
  const findings = numberValue(run.diagnostic_count) ?? 0;
  return findings > 0 ? `${name} ${status}/${findings}` : `${name} ${status}`;
}

function cleanupSummary(data: LensRecord | undefined): string | undefined {
  const cleanup = asRecord(
    data?.data?.health?.summary?.cleanup ?? data?.data?.summary?.cleanup,
  );
  const runs = numberValue(cleanup?.runs);
  const failed = numberValue(cleanup?.failed);
  const timedOut = numberValue(cleanup?.timed_out);
  if (runs === undefined && failed === undefined && timedOut === undefined)
    return undefined;
  if ((failed ?? 0) === 0 && (timedOut ?? 0) === 0) return undefined;
  return `cleanup ${runs ?? 0} run/${failed ?? 0} failed/${timedOut ?? 0} timeout`;
}

function patchSummary(data: LensRecord | undefined): string | undefined {
  const patch = asRecord(
    data?.data?.health?.summary?.patch_refs ?? data?.data?.summary?.patch_refs,
  );
  const drafts = numberValue(patch?.draft_refs);
  const hunks = numberValue(patch?.hunks);
  const accepts = numberValue(patch?.accepted_events);
  if ((hunks ?? 0) === 0 && (accepts ?? 0) === 0) return undefined;
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
  for (const child of Object.values(item))
    if (child && typeof child === "object") collect(child, each);
}

function severityIcon(severity: LensSeverity): string {
  switch (severity) {
    case "pending":
      return "…";
    case "clean":
      return "✓";
    case "warning":
      return "⚠";
    case "degraded":
      return "◌";
    case "error":
      return "✗";
    default:
      return "?";
  }
}

function severityColor(severity: LensSeverity): keyof typeof ansi {
  switch (severity) {
    case "pending":
      return "action";
    case "clean":
      return "clean";
    case "warning":
      return "warning";
    case "degraded":
      return "degraded";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

function colorDetailLine(line: string, style: boolean): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("warning:")) return paint("warning", line, style);
  if (trimmed.startsWith("error:")) return paint("error", line, style);
  if (trimmed.startsWith("action:")) return paint("action", line, style);
  if (trimmed.startsWith("fix:")) return paint("fix", line, style);
  if (trimmed.startsWith("ack:")) return paint("ack", line, style);
  if (trimmed.startsWith("diagnostics:"))
    return paint("diagnostics", line, style);
  if (trimmed.startsWith("cleanup:")) return paint("cleanup", line, style);
  if (
    trimmed.startsWith("collecting:") ||
    trimmed.startsWith("end turn:") ||
    trimmed.startsWith("checks ran:") ||
    trimmed.startsWith("suggested:")
  )
    return paint("action", line, style);
  if (trimmed.startsWith("patch:")) return paint("patch", line, style);
  if (trimmed.startsWith("refs:")) return paint("muted", line, style);
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
