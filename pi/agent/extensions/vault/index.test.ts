import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vaultExtension, {
	buildVaultCommitArgs,
	buildVaultCreateArgs,
	kindArgs,
	runPlannotatorGate,
	runPlannotatorReview,
} from "./index";

type Handler = (data: any) => void;

function fakePi(handler?: Handler) {
	const tools: any[] = [];
	return {
		tools,
		pi: {
			registerTool(tool: any) {
				tools.push(tool);
			},
			events: handler
				? {
						emit(_channel: string, data: any) {
							handler(data);
						},
					}
				: undefined,
		} as any,
	};
}

describe("vault tool argument builders", () => {
	test("maps artifact kinds to ct vault args", () => {
		expect(kindArgs(undefined)).toEqual([]);
		expect(kindArgs("all")).toEqual([]);
		expect(kindArgs("research")).toEqual(["--type", "research"]);
	});

	test("builds create and commit args", () => {
		expect(
			buildVaultCreateArgs({
				type: "research",
				topic: "Review gate",
				tags: ["stage/research", "  ", "domain/vault"],
				source: "source-stem",
				dive: true,
			}),
		).toEqual([
			"create",
			"--type",
			"research",
			"--topic",
			"Review gate",
			"--tags",
			"stage/research,domain/vault",
			"--source",
			"source-stem",
			"--dive",
		]);
		expect(buildVaultCommitArgs({ path: "/tmp/research.md", message: "research: update" })).toEqual([
			"commit",
			"/tmp/research.md",
			"--message",
			"research: update",
		]);
	});
});

describe("vault extension registration", () => {
	test("registers vault and Plannotator bridge tools", () => {
		const { pi, tools } = fakePi();
		vaultExtension(pi);
		expect(tools.map((tool) => tool.name).sort()).toEqual(["vault_read", "vault_review", "vault_write"]);
	});

	test("renders like native silent tools", () => {
		const { pi, tools } = fakePi();
		vaultExtension(pi);
		const tool = tools.find((candidate) => candidate.name === "vault_read");
		expect(tool.renderShell).toBe("self");
		expect(tool.renderCall().render()).toEqual([]);
		expect(tool.renderResult().render()).toEqual([]);
	});
});

describe("Plannotator gate bridge", () => {
	test("emits one request for one annotation gate", async () => {
		let emits = 0;
		const { pi } = fakePi((request) => {
			emits += 1;
			request.respond({ status: "handled", result: { approved: true } });
		});
		await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(emits).toBe(1);
	});

	test("coalesces duplicate in-flight annotation gates", async () => {
		let emits = 0;
		let respond: ((response: unknown) => void) | undefined;
		const { pi } = fakePi((request) => {
			emits += 1;
			respond = request.respond;
		});
		const first = runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		const second = runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		respond?.({ status: "handled", result: { approved: true } });
		await Promise.all([first, second]);
		expect(emits).toBe(1);
	});

	test("approves annotation gates", async () => {
		const { pi } = fakePi((request) => {
			request.respond({ status: "handled", result: { approved: true, savedPath: "/tmp/saved.md" } });
		});
		const result = await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(result.details?.approved).toBe(true);
		expect(result.details?.savedPath).toBe("/tmp/saved.md");
	});

	test("fails closed on denial feedback", async () => {
		const { pi } = fakePi((request) => {
			request.respond({ status: "handled", result: { approved: false, feedback: "needs edits" } });
		});
		const result = await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(result.details?.approved).toBe(false);
		expect(result.content[0].text).toContain("needs edits");
	});

	test("fails closed when unavailable", async () => {
		const { pi } = fakePi();
		const result = await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(result.details?.approved).toBe(false);
		expect(result.content[0].text).toContain("unavailable");
	});

	test("fails closed on timeout", async () => {
		const { pi } = fakePi(() => {});
		const result = await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 1,
		});
		expect(result.details?.approved).toBe(false);
		expect(result.content[0].text).toContain("timed out");
	});

	test("fails closed on close/no feedback", async () => {
		const { pi } = fakePi((request) => {
			request.respond({ status: "handled", result: { exit: true } });
		});
		const result = await runPlannotatorGate(pi, {
			targetPath: "/repo/research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(result.details?.approved).toBe(false);
		expect(result.content[0].text).toContain("closed");
	});

	test("fails closed before opening Plannotator for relative target paths", async () => {
		let emits = 0;
		const { pi } = fakePi(() => {
			emits += 1;
		});
		const result = await runPlannotatorGate(pi, {
			targetPath: "research.md",
			gateType: "research",
			timeoutMs: 50,
		});
		expect(emits).toBe(0);
		expect(result.details?.approved).toBe(false);
		expect(result.content[0].text).toContain("could not be resolved");
	});

	test("resolves project-relative vault target paths before opening Plannotator", async () => {
		const previousBlueprintsDir = process.env.CT_BLUEPRINTS_DIR;
		const blueprints = mkdtempSync(join(tmpdir(), "plannotator-vault-"));
		const artifactDir = join(blueprints, "majin", "research");
		const artifactPath = join(artifactDir, "20260511-renderer.md");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(artifactPath, "# Renderer research\n");

		try {
			process.env.CT_BLUEPRINTS_DIR = blueprints;
			let reviewedPath = "";
			const { pi } = fakePi((request) => {
				reviewedPath = request.payload.filePath;
				request.respond({ status: "handled", result: { approved: true } });
			});
			const result = await runPlannotatorGate(pi, {
				targetPath: "majin/research/20260511-renderer.md",
				gateType: "research",
				timeoutMs: 50,
			});
			expect(result.details?.approved).toBe(true);
			expect(reviewedPath).toBe(realpathSync(artifactPath));
			expect(result.details?.target).toBe(realpathSync(artifactPath));
		} finally {
			if (previousBlueprintsDir === undefined) {
				delete process.env.CT_BLUEPRINTS_DIR;
			} else {
				process.env.CT_BLUEPRINTS_DIR = previousBlueprintsDir;
			}
			rmSync(blueprints, { recursive: true, force: true });
		}
	});
});

describe("Plannotator review bridge", () => {
	test("approves code review gates", async () => {
		const { pi } = fakePi((request) => {
			request.respond({ status: "handled", result: { approved: true, reviewId: "r1" } });
		});
		const result = await runPlannotatorReview(pi, { cwd: "/repo" } as any, {
			diffType: "uncommitted",
			timeoutMs: 50,
		});
		expect(result.details?.approved).toBe(true);
		expect(result.details?.reviewId).toBe("r1");
	});
});
