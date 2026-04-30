import { describe, expect, it } from "bun:test";

import {
  LENS_TOOL_NAMES,
  renderLensCompactStatus,
  renderLensWidgetLines,
  summarizeLensResult,
} from "./lens-ui.ts";

const clean = {
  status: "ok",
  data: {
    status: "clean",
    compact: "clean · 0 changed · 0 diag",
    summary: {
      diagnostics: { active: 0, errors: 0, warnings: 0 },
      lsp: { connected: [{ name: "rust-analyzer" }], missing: [] },
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
      cleanup: { runs: 2, failed: 0, timed_out: 0 },
      checks: { snapshots: 1, latest: [{ exit_code: 1, diagnostic_count: 2 }] },
      patch_refs: { draft_refs: 0, hunks: 0, accepted_events: 0 },
    },
  },
  warnings: [
    { code: "diagnostics_active", message: "active diagnostics remain" },
  ],
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
    files: [
      {
        cleanup_actions: [{ raw_output_ref: 42 }],
        patch_refs: { draft_id: 7 },
      },
    ],
  },
};

const pending = {
  status: "ok",
  data: {
    status: "pending",
    compact: "pending · 2 changed · end: cleanup + 1 auto + 1 suggested",
    summary: {
      changed_files: { count: 2, paths: ["a.rs", "b.rs"] },
      validation_plan: {
        turn_active: true,
        cleanup_pending: true,
        automatic_checks: ["cargo fmt --check"],
        automatic_scanners: [],
        suggestions: ["cargo clippy -- -D warnings"],
      },
      diagnostics: { active: 0, errors: 0, warnings: 0 },
      lsp: {
        connected: [{ name: "rust-analyzer" }],
        missing: [{ name: "typescript" }],
      },
      cleanup: { runs: 0, failed: 0, timed_out: 0 },
      checks: { snapshots: 0, latest: [] },
      patch_refs: { draft_refs: 0, hunks: 0, accepted_events: 0 },
    },
  },
};

describe("Lens Pi UI rendering", () => {
  it("exposes the collision-safe flat Pi tool namespace", () => {
    expect(LENS_TOOL_NAMES).toEqual([
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
    ]);
    expect(new Set(LENS_TOOL_NAMES).size).toBe(LENS_TOOL_NAMES.length);
  });

  it("renders compact clean, warning, degraded/error, and patch states", () => {
    expect(renderLensCompactStatus(clean)).toContain("󰛩 Lens ✓ clean");
    expect(renderLensCompactStatus(clean)).toContain("lsp: rust-analyzer");
    expect(renderLensCompactStatus(warning)).toContain("󰛩 Lens ⚠ warning");
    expect(renderLensCompactStatus(warning)).toContain("checks 1 err/0 warn");
    expect(renderLensCompactStatus(pending)).toContain("󰛩 Lens … pending");
    expect(renderLensCompactStatus(pending)).toContain(
      "queue: cargo fmt --check",
    );
    expect(renderLensCompactStatus(pending)).toContain(
      "suggested: cargo clippy -- -D warnings",
    );
    expect(renderLensCompactStatus(pending)).toContain("lsp: rust-analyzer");
    expect(renderLensCompactStatus(pending)).not.toContain("lsp missing");
    expect(renderLensCompactStatus(degraded)).toContain("󰛩 Lens ◌ degraded");
    expect(renderLensCompactStatus(patchTelemetry)).toContain(
      "patch 2 drafts/5 hunks/1 accepts",
    );
  });

  it("can render dim ANSI color by status section", () => {
    const rendered = renderLensCompactStatus(warning, { ansi: true });
    expect(rendered).toContain("\x1b[2;38;5;111m󰛩 Lens\x1b[0m");
    expect(rendered).toContain("\x1b[2;38;5;179m⚠ warning\x1b[0m");
    expect(rendered).toContain("\x1b[2;38;5;181mdiag 3 (1 err/2 warn)\x1b[0m");
    expect(rendered).not.toContain("cleanup 2 run/0 failed/0 timeout");
  });

  it("renders actionable expanded widget lines", () => {
    const lines = renderLensWidgetLines(warning, true);
    expect(lines).toContain("  warning: active diagnostics remain");
    expect(lines).toContain(
      "  action: Resolve active diagnostics before handoff.",
    );
    expect(lines).toContain("  diagnostics: resolve 1 error(s), 2 warning(s)");
    expect(lines).toContain(
      "  checks: inspect 1 recent check/scanner snapshot(s)",
    );
    expect(lines.some((line) => line.includes("ack:"))).toBe(true);
  });

  it("renders active-turn collection and pending validation plan details", () => {
    const lines = renderLensWidgetLines(pending, true);
    expect(lines).toContain("  collecting: 2 touched file(s)");
    expect(lines).toContain("  queue: cargo fmt --check");
    expect(lines).toContain("  suggested: cargo clippy -- -D warnings");
  });

  it("preserves full JSON in details while summarizing tool results", () => {
    const toolResult = { details: { results: warning, extra: { full: true } } };
    expect(summarizeLensResult(toolResult, false)).toContain("Lens ⚠ warning");
    expect(toolResult.details.results.data.action_context.instructions).toBe(
      "Resolve active diagnostics before handoff.",
    );
  });

  it("surfaces patch telemetry refs in expanded rendering", () => {
    const lines = renderLensWidgetLines(patchTelemetry, true);
    expect(lines).toContain(
      "  patch: inspect telemetry refs (2 drafts, 5 hunks, 1 accepts)",
    );
    expect(lines).toContain("  refs: raw:42, draft:7");
  });
});
