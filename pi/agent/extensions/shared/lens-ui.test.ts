import { describe, expect, it } from "bun:test";

import { LENS_TOOL_NAMES, renderLensCompactStatus, renderLensWidgetLines, summarizeLensResult } from "./lens-ui.ts";

const clean = {
	status: "ok",
	data: {
		status: "clean",
		compact: "clean · 0 changed · 0 diag",
		summary: {
			diagnostics: { active: 0, errors: 0, warnings: 0 },
			cleanup: { runs: 0, failed: 0, timed_out: 0 },
			patch_refs: { draft_refs: 0, hunks: 0, accepted_events: 0 },
		},
	},
};

const warning = {
	status: "warning",
	data: {
		status: "warning",
		compact: "warning · diagnostics need attention",
		action_context: {
			required: true,
			instructions: "Resolve active diagnostics before handoff.",
			remediation: ["Run lens_diagnostics action=list", "Fix reported files"],
			ack_command: "ct lens context --ack --session s --turn t",
		},
		summary: {
			diagnostics: { active: 3, errors: 1, warnings: 2 },
			guard: { clean: 1, warnings: 1, blocked: 0 },
			cleanup: { runs: 2, failed: 0, timed_out: 0 },
			patch_refs: { draft_refs: 0, hunks: 0, accepted_events: 0 },
		},
	},
	warnings: [{ code: "diagnostics_active", message: "active diagnostics remain" }],
};

const blocked = {
	status: "error",
	decision: { outcome: "block", reason: "strict_guard_blocked", guard: [{ decision: "block" }] },
	health: { status: "blocked", compact: "blocked · read coverage required" },
	data: {
		health: {
			summary: {
				guard: { clean: 0, warnings: 0, blocked: 1 },
				diagnostics: { active: 0, errors: 0, warnings: 0 },
			},
		},
	},
	errors: [{ code: "guard_blocked", message: "strict Lens guard blocked one or more write targets" }],
};

const degraded = {
	status: "error",
	health: { status: "degraded", compact: "degraded · hook failed" },
	errors: [{ code: "hook_failed", message: "ct hook failed" }],
};

const patchTelemetry = {
	status: "warning",
	data: {
		status: "warning",
		summary: {
			diagnostics: { active: 0, errors: 0, warnings: 0 },
			cleanup: { runs: 1, failed: 1, timed_out: 0, raw_output_refs: [42] },
			patch_refs: { draft_refs: 2, hunks: 5, accepted_events: 1 },
		},
		files: [{ cleanup_actions: [{ raw_output_ref: 42 }], patch_refs: { draft_id: 7 } }],
	},
};

describe("Lens Pi UI rendering", () => {
	it("exposes the collision-safe flat Pi tool namespace", () => {
		expect(LENS_TOOL_NAMES).toEqual([
			"lens_discover",
			"lens_guard",
			"lens_diagnostics",
			"lens_health",
			"lens_cleanup",
			"lens_report",
			"lens_context",
		]);
		expect(new Set(LENS_TOOL_NAMES).size).toBe(LENS_TOOL_NAMES.length);
	});

	it("renders compact clean, warning, blocked, degraded/error, and patch states", () => {
		expect(renderLensCompactStatus(clean)).toBe("󰛩 Lens ✓ clean · clean · 0 changed · 0 diag · diag 0 (0 err/0 warn) · cleanup 0 run/0 failed/0 timeout");
		expect(renderLensCompactStatus(warning)).toContain("󰛩 Lens ⚠ warning");
		expect(renderLensCompactStatus(blocked)).toContain("󰛩 Lens ⛔ blocked");
		expect(renderLensCompactStatus(degraded)).toContain("󰛩 Lens ◌ degraded");
		expect(renderLensCompactStatus(patchTelemetry)).toContain("patch 2 drafts/5 hunks/1 accepts");
	});

	it("renders actionable expanded widget lines", () => {
		const lines = renderLensWidgetLines(warning, true);
		expect(lines).toContain("  warning: active diagnostics remain");
		expect(lines).toContain("  action: Resolve active diagnostics before handoff.");
		expect(lines).toContain("  diagnostics: resolve 1 error(s), 2 warning(s)");
		expect(lines.some((line) => line.includes("ack:"))).toBe(true);
	});

	it("preserves full JSON in details while summarizing tool results", () => {
		const toolResult = { details: { results: warning, extra: { full: true } } };
		expect(summarizeLensResult(toolResult, false)).toContain("Lens ⚠ warning");
		expect(toolResult.details.results.data.action_context.instructions).toBe("Resolve active diagnostics before handoff.");
	});

	it("surfaces patch telemetry refs in expanded rendering", () => {
		const lines = renderLensWidgetLines(patchTelemetry, true);
		expect(lines).toContain("  patch: inspect telemetry refs (2 drafts, 5 hunks, 1 accepts)");
		expect(lines).toContain("  refs: raw:42, draft:7");
	});
});
