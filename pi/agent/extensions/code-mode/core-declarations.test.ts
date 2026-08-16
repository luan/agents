import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTool } from "../shared/tool-registry.ts";
import { buildSystemPrompt } from "../system-prompt/index.ts";
import { buildCoreToolDeclarations } from "./nested-dispatch.ts";

// Two earlier versions failed nothing: one mutated `systemPromptOptions.toolSnippets` after `_rebuildSystemPrompt` had
// run, the other appended to `event.systemPrompt`, which the system-prompt extension discards wholesale.
it("renders the core tool declarations into the system prompt", () => {
	registerTool({ registerTool() {} } as never, {
		name: "exec_command",
		description: "Runs one shell command.",
		parameters: {
			type: "object",
			properties: { cmd: { type: "string" }, workdir: { type: "string" } },
			required: ["cmd"],
		},
		execute: () => ({ content: [] }),
	});

	const declarations = buildCoreToolDeclarations();
	expect(declarations).toContain("declare const tools: {");
	expect(declarations).toContain(
		"\texec_command(args: {\n\t\tcmd: string;\n\t\tworkdir?: string;\n\t}): Promise<CallResult>;",
	);

	const prompt = buildSystemPrompt("", { cwd: "/tmp", selectedTools: ["exec", "wait", "ask_user"] });

	expect(prompt).toContain(
		"\texec_command(args: {\n\t\tcmd: string;\n\t\tworkdir?: string;\n\t}): Promise<CallResult>;",
	);
});

it("declares an optional projected result and reuses a named details type", () => {
	const details = {
		title: "CommandDetails",
		type: "object",
		properties: { exit_code: { type: "number" }, wall_time_seconds: { type: "number" } },
		required: ["wall_time_seconds"],
	};
	for (const name of ["exec_command", "write_stdin"]) {
		registerTool({ registerTool() {} } as never, {
			name,
			parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
			nestedResult: { details },
			execute: () => ({ content: [] }),
		});
	}

	const declarations = buildCoreToolDeclarations(["exec_command", "write_stdin"]);

	expect(declarations?.match(/type CommandDetails =/g)).toHaveLength(1);
	expect(declarations).toContain("details?: T | OmittedDetails");
	expect(declarations).toContain("exec_command(value: string): Promise<ToolResult<CommandDetails>>;");
	expect(declarations).toContain("write_stdin(value: string): Promise<ToolResult<CommandDetails>>;");
});

// A summary of the description cost `edit` its input format, `search` its routing argument and `read` its summary footer.
// Declared omits the JSON schema, never the description.
it("renders every declared tool's whole description", () => {
	registerTool({ registerTool() {} } as never, {
		name: "ast_grep",
		description: "Structural AST search using ast-grep CLI (`sg`). Supports metavariable patterns such as `foo($X)`.",
		parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
		execute: () => ({ content: [] }),
	});

	const declarations = buildCoreToolDeclarations();

	expect(declarations).toContain("Structural AST search using ast-grep CLI (`sg`).");
	expect(declarations).toContain("metavariable patterns such as `foo($X)`");
});

it("renders a multi-paragraph description in full, with no compact substitute", () => {
	registerTool({ registerTool() {} } as never, {
		name: "edit",
		description: "Change lines in a file.\n\nhashline patch: a `[PATH#TAG]` section header, then hunks.",
		promptSnippet: "Change lines in a file you have read.",
		parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
		execute: () => ({ content: [] }),
	});

	const declarations = buildCoreToolDeclarations();

	expect(declarations).toContain(
		"\t * Change lines in a file.\n\t *\n\t * hashline patch: a `[PATH#TAG]` section header, then hunks.",
	);
	expect(declarations).not.toContain("input format:");
	expect(declarations).not.toContain("Change lines in a file you have read.");
});

it("promotes TOML tools from the session cwd into the prompt", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-toml-prompt-"));
	const directory = join(cwd, ".pi", "codex-conversion-custom-tools");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "project_probe.toml"),
		'usage = "value to print"\ndescription = "Project-local probe."\ncommand = "printf"\ndefer_loading = false\n',
	);

	const prompt = buildSystemPrompt("", { cwd, selectedTools: ["exec"], codeMode: true });

	expect(prompt).toContain("project_probe(");
});
it("renders nothing rather than an empty heading", () => {
	const prompt = buildSystemPrompt("", {
		cwd: "/tmp",
		selectedTools: ["exec"],
		coreToolDeclarations: null,
	});

	expect(prompt).not.toContain("Core tools, already declared");
});
