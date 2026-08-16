import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedArguments = [
	"status",
	"reload",
	"code-mode on",
	"code-mode off",
	"edit hashline",
	"edit apply_patch",
	"edit replace",
];

test("registers only /agent-settings with its supported arguments", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-agent-settings-"));
	const moduleUrl = new URL("./codex-apps.ts", import.meta.url).href;
	const probe = `
		import register from ${JSON.stringify(moduleUrl)};
		const commands = {};
		const pi = {
			registerTool() {},
			registerCommand(name, definition) { commands[name] = definition; },
			getCommands() { return []; },
			getAllTools() { return []; },
			on() {},
		};
		await register(pi);
		console.log(JSON.stringify({
			commands: Object.keys(commands),
			arguments: commands["agent-settings"].getArgumentCompletions("").map(({ value }) => value),
		}));
	`;
	try {
		const child = spawnSync("bun", ["-e", probe], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home },
		});
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ commands: ["agent-settings"], arguments: expectedArguments });
	} finally {
		rmSync(home, { force: true, recursive: true });
	}
});
