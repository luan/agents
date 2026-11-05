import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import xsettings from "../src/extension.ts";

interface SelectionCase {
	name: string;
	defaultTools: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all";
	expected: string[];
	reloaded: string[];
}

const cases: SelectionCase[] = [
	{
		name: "configured baseline",
		defaultTools: ["codemode", "fixture"],
		expected: ["codemode", "fixture"],
		reloaded: ["codemode", "extra", "fixture"],
	},
	{
		name: "relative selection",
		defaultTools: ["+codemode", "+fixture", "-bash", "-read", "-edit", "-write"],
		expected: ["codemode", "fixture"],
		reloaded: ["codemode", "extra", "fixture"],
	},
	{
		name: "tool allowlist",
		defaultTools: ["codemode", "fixture"],
		tools: ["fixture"],
		expected: ["fixture"],
		reloaded: ["fixture"],
	},
	{
		name: "excluded tool",
		defaultTools: ["codemode", "fixture"],
		excludeTools: ["fixture"],
		expected: ["codemode"],
		reloaded: ["codemode", "extra"],
	},
	{ name: "all tools disabled", defaultTools: ["codemode", "fixture"], noTools: "all", expected: [], reloaded: [] },
	{ name: "empty configured selection", defaultTools: [], expected: [], reloaded: ["extra", "fixture"] },
];

test.each(cases)(
	"tool selection respects startup constraints and native branch restoration: $name",
	async (selection) => {
		const root = await mkdtemp(join(tmpdir(), "pi-xsettings-selection-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			await writeFile(
				join(root, "settings.json"),
				JSON.stringify({ defaultTools: selection.defaultTools, codemode: { mode: "only" } }),
			);
			const settingsManager = SettingsManager.create(root, root, { projectTrusted: false });
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(root, "models.json"),
				refreshOnCreate: false,
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager,
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				extensionFactories: [
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					xsettings,
					(pi) => {
						for (const name of ["fixture", "extra"]) {
							pi.registerTool({
								name,
								label: name,
								description: "Fixture tool",
								parameters: Type.Object({}),
								execute: async () => ({ content: [], details: {} }),
							});
						}
					},
				],
			});
			await resourceLoader.reload();
			const manager = SessionManager.inMemory(root);
			const emptyBranch = manager.appendMessage({ role: "system", content: "", toolsAdded: [], timestamp: 1 });
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				settingsManager,
				modelRuntime,
				resourceLoader,
				sessionManager: manager,
				tools: selection.tools,
				excludeTools: selection.excludeTools,
				noTools: selection.noTools,
			});
			try {
				const errors: string[] = [];
				session.setActiveToolsByName([]);
				await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
				expect(session.getActiveToolNames().sort()).toEqual(selection.expected);
				session.setActiveToolsByName([]);
				expect(session.getCallableToolNames()).not.toContain("fixture");
				const messages = [...session.messages];
				await session.reload();
				expect(errors).toEqual([]);
				expect(session.getActiveToolNames().sort()).toEqual(selection.reloaded);
				expect(session.getCallableToolNames().includes("fixture")).toBe(selection.reloaded.includes("fixture"));
				expect(session.messages).toEqual(messages);
				await session.navigateTree(emptyBranch, { summarize: false });
				// Pi retains defaults for extension tools absent from the recorded branch.
				expect(session.getActiveToolNames().sort()).toEqual(selection.reloaded);
				expect(session.getCallableToolNames().includes("fixture")).toBe(selection.reloaded.includes("fixture"));
				session.setActiveToolsByName(["extra"]);
				await session.reload();
				expect(session.getActiveToolNames().sort()).toEqual(selection.reloaded);
			} finally {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	},
);
