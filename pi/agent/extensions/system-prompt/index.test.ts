import { describe, expect, test } from "bun:test";
import { DEFAULT_EXEC_SHELL } from "../exec-command/adapter/runtime-shell";
import { buildSystemPrompt } from "./index";

const baseOptions = {
	cwd: "/repo",
	skills: [
		{
			name: "tdd",
			description: "Apply test-driven development",
			filePath: "/skills/tdd/SKILL.md",
			baseDir: "/skills/tdd",
			sourceInfo: { path: "/skills/tdd/SKILL.md", source: "test", scope: "project", origin: "top-level" },
			disableModelInvocation: false,
		},
	],
};

describe("system-prompt Skillful skill rendering", () => {
	test("renders fish shells as the exec_command fallback shell", () => {
		const expectedShell = DEFAULT_EXEC_SHELL.split(/[\\/]/).filter(Boolean).at(-1);
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			now: new Date(2026, 4, 10),
			environmentContext: {
				shell: "/opt/homebrew/bin/fish",
				timezone: "America/New_York",
			},
		});

		expect(prompt).toContain(`<shell>${expectedShell}</shell>`);
		expect(prompt).not.toContain("<shell>fish</shell>");
	});

	test("renders environment metadata as structured environment context", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			now: new Date(2026, 4, 10),
			environmentContext: {
				shell: "zsh",
				timezone: "America/New_York",
			},
		});

		expect(prompt).toContain(`<environment_context>
  <cwd>/repo</cwd>
  <shell>zsh</shell>
  <current_date>2026-05-10</current_date>
  <timezone>America/New_York</timezone>
</environment_context>`);
	});

	test("renders multiple environments with XML escaping", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			now: new Date(2026, 4, 10),
			environmentContext: {
				environments: [
					{ id: "local", cwd: "/repo & one", shell: "zsh" },
					{ id: `remote"two`, cwd: "/srv/<app>", shell: "bash" },
				],
				timezone: "Etc/UTC",
			},
		});

		expect(prompt).toContain(`<environments>
    <environment id="local">
      <cwd>/repo &amp; one</cwd>
      <shell>zsh</shell>
    </environment>
    <environment id="remote&quot;two">
      <cwd>/srv/&lt;app&gt;</cwd>
      <shell>bash</shell>
    </environment>
  </environments>`);
		expect(prompt).toContain("<timezone>Etc/UTC</timezone>");
	});

	test("tool guidance keeps dedicated file tools and shell search non-contradictory", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read", "search", "find", "edit", "exec_command"],
		});

		expect(prompt).toContain("use `sym` first when it can answer the question");
		expect(prompt).toContain("use active file tools when you need hashline-editable line context");
		expect(prompt).toContain("Use `read` for known file paths");
		expect(prompt).toContain("Use `search` for file-content matching");
		expect(prompt).toContain("Use `find` for file discovery by glob or path");
		expect(prompt).not.toContain("Prefer active dedicated file tools for file and text workflows");
		expect(prompt).not.toContain("Use `apply_patch` for manual code edits");
		expect(prompt).not.toContain("/edit-config");
		expect(prompt).not.toContain("RTK");
		expect(prompt).not.toContain("rtk grep");
	});

	test("omits dedicated file tool guidance when only shell execution is active", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["exec_command"],
		});

		expect(prompt).not.toContain("Use `read` for known file paths");
		expect(prompt).not.toContain("Use `search` for file-content matching");
		expect(prompt).not.toContain("Use `find` for file discovery by glob or path");
		expect(prompt).toContain("Use `exec_command` for shell-only workflows");
	});

	test("skill tool active lists skills by name and description only", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["skill"],
		});

		expect(prompt).toContain("The following skills provide specialized instructions");
		expect(prompt).toContain("call `skill({name})`");
		expect(prompt).toContain('matching `<skill name="...">` block is already in context');
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).not.toContain("/skills/tdd/SKILL.md");
	});

	test("read fallback keeps skill locations", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read"],
		});

		expect(prompt).toContain("read the referenced `SKILL.md` file");
		expect(prompt).toContain("- tdd: Apply test-driven development (/skills/tdd/SKILL.md)");
	});

	test("omits skills when no loading tool is active", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
		});

		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).not.toContain("- tdd: Apply test-driven development");
	});

	test("renders pi feature guidance for templates and autocomplete providers", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
		});

		expect(prompt).toContain("default positional arguments such as `");
		expect(prompt).toContain("$" + "{1:-7}`");
		expect(prompt).toContain("set `triggerCharacters` on the provider");
		expect(prompt).toContain("instead of patching editor input");
	});

	test("renders context files contributed through system prompt options", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
			contextFiles: [{ path: "/repo/AGENTS.local.md", content: "LOCAL_SENTINEL" }],
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## /repo/AGENTS.local.md");
		expect(prompt).toContain("LOCAL_SENTINEL");
	});
});
