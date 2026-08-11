import { describe, expect, it } from "bun:test";
import type { Resource } from "@earendil-works/pi-coding-agent";

import { summarizeResource } from "./index.ts";

/**
 * Every one of these views once rendered an empty card, or rendered the pull
 * request's own body in place of the item's. The card reads the resource, so a
 * view that changes shape has to be checked against the card, not just against
 * the token count.
 */
const base = {
	number: 62946,
	repository: "owner/repo",
	title: "Route synthesis through AI Service messages",
	state: "OPEN",
	body: "The pull request description, which is not any item's body.",
	headRefName: "feature",
	baseRefName: "main",
};

function resource(kind: string, path: string, payload: Record<string, unknown>): Resource {
	return {
		uri: `pr://owner/repo/62946${path}`,
		name: "62946",
		kind,
		mediaType: "text/plain",
		metadata: { ...base, ...payload },
	};
}

function rowText(summary: ReturnType<typeof summarizeResource>): string {
	return (summary?.rows ?? [])
		.map((row) => `${row.text} ${(row.details ?? []).map((d) => d.text).join(" ")}`)
		.join("\n");
}

describe("github resource cards", () => {
	it("renders a commits listing", () => {
		const summary = summarizeResource(
			resource("pull-request-commits", "/commits", {
				items: [{ sha: "5469c31ea6062404", message: "Route synthesis\n\nbody", author: "philip" }],
			}),
			"",
		);
		expect(rowText(summary)).toContain("Route synthesis");
		expect(summary?.uri?.text).toBe("pr://owner/repo/62946/commits");
	});

	it("renders a checks listing without a duplicate checks column", () => {
		const summary = summarizeResource(
			resource("pull-request-checks", "/checks", {
				statusCheckRollup: [{ name: "Build", status: "completed", conclusion: "FAILURE" }],
				items: [
					{ name: "Build", status: "completed", conclusion: "FAILURE" },
					{ name: "Lint", status: "completed", conclusion: "SUCCESS" },
				],
			}),
			"",
		);
		expect(rowText(summary)).toContain("Build");
		expect(summary?.sideRows ?? []).toHaveLength(0);
	});

	it("renders a threads listing and says so when there are none", () => {
		const listed = summarizeResource(
			resource("pull-request-threads", "/threads", {
				items: [{ id: "T1", path: "src/a.ts", line: 12, isResolved: false, comments: 2, preview: "needs work" }],
			}),
			"",
		);
		expect(rowText(listed)).toContain("src/a.ts:12");
		expect(rowText(listed)).toContain("unresolved");

		const empty = summarizeResource(resource("pull-request-threads", "/threads", { items: [] }), "");
		expect(rowText(empty)).toContain("No threads.");
	});

	it("renders a thread's own comments, not the pull request body", () => {
		const summary = summarizeResource(
			resource("pull-request-thread", "/threads/T1", {
				id: "T1",
				path: "src/a.ts",
				line: 12,
				isResolved: false,
				comments: { nodes: [{ author: "reviewer", body: "This needs a guard." }] },
			}),
			"",
		);
		expect(summary?.markdown).toContain("This needs a guard.");
		expect(summary?.markdown).not.toContain("pull request description");
	});

	it("renders a comment body as markdown", () => {
		const summary = summarizeResource(
			resource("github-comment", "/comments/1", { id: 1, author: "philip", body: "# Heading\n\nA comment." }),
			"",
		);
		expect(summary?.markdown).toContain("A comment.");
	});

	it("puts the author on its own row and the body under it, both linked", () => {
		const summary = summarizeResource(
			resource("github-comments", "/comments", {
				items: [
					{
						id: 1,
						author: "philip",
						date: "2026-08-04T21:44:33Z",
						body: "## Heading\n\nThe comment body.",
						url: "https://github.com/owner/repo/pull/62946#issuecomment-1",
					},
				],
			}),
			"",
		);
		const row = summary?.rows?.[0];
		expect(row?.text).toBe("@philip");
		expect(row?.textUrl).toBe("https://github.com/owner/repo/pull/62946#issuecomment-1");
		expect(row?.markdown).toContain("The comment body.");
	});

	it("links every row that names something navigable", () => {
		const files = summarizeResource(
			resource("pull-request-files", "/files", {
				items: [
					{ filename: "src/a.ts", additions: 2, deletions: 1, url: "https://github.com/owner/repo/blob/x/a" },
				],
			}),
			"",
		);
		expect(files?.rows?.[0]?.textUrl).toBe("https://github.com/owner/repo/blob/x/a");

		const checks = summarizeResource(
			resource("pull-request-checks", "/checks", {
				items: [
					{
						name: "Build",
						status: "completed",
						conclusion: "FAILURE",
						url: "https://github.com/owner/repo/runs/1",
					},
				],
			}),
			"",
		);
		expect(checks?.rows?.some((row) => row.textUrl === "https://github.com/owner/repo/runs/1")).toBe(true);
	});

	it("reports the blocker rather than a flat 'not ready'", () => {
		const summary = summarizeResource(
			resource("pr", "", {
				reviewDecision: "APPROVED",
				mergeable: "MERGEABLE",
				mergeStateStatus: "BLOCKED",
				statusCheckRollup: [{ name: "Build", status: "completed", conclusion: "FAILURE" }],
			}),
			"",
		);
		expect(summary?.subtitleStatus?.label).toBe("checks failing");
	});
});
