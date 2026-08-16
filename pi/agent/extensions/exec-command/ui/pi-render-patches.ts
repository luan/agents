import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type RenderTheme, renderExecCell } from "../tools/exec-cell-presentation.ts";

const EMPTY_SELF_SHELL_ROW_PATCH = Symbol.for("agents.exec-command.empty-self-shell-row-patch");
const USER_BASH_RENDER_PATCH = Symbol.for("agents.exec-command.user-bash-render-patch");
const ANSI_PATTERN =
	/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*(?:\u001b\\)|_[^\u001b]*(?:\u001b\\)|\^[^\u001b]*(?:\u001b\\))/g;
const ANSI_RESET = "\x1b[0m";
const USER_BASH_RENDER_THEME: RenderTheme = {
	fg: (role, text) => `${ansiForRole(role)}${text}${ANSI_RESET}`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

interface ToolExecutionPrototype {
	render(width: number): string[];
	getRenderShell?(): "default" | "self";
	hasRendererDefinition?(): boolean;
	[EMPTY_SELF_SHELL_ROW_PATCH]?: true;
}

interface BashExecutionPrototype {
	command: string;
	outputLines: string[];
	status: "running" | "complete" | "cancelled" | "error";
	exitCode?: number;
	loader?: unknown;
	truncationResult?: { truncated?: boolean; content?: string };
	fullOutputPath?: string;
	expanded: boolean;
	contentContainer: { clear(): void; addChild(child: unknown): void };
	[USER_BASH_RENDER_PATCH]?: true;
	updateDisplay(): void;
	render(width: number): string[];
}

function ansiForRole(role: string): string {
	switch (role) {
		case "success":
			return "\x1b[32m";
		case "error":
			return "\x1b[31m";
		case "dim":
			return "\x1b[2m";
		case "muted":
			return "\x1b[38;5;244m";
		case "syntaxFunction":
			return "\x1b[38;2;220;220;170m";
		case "syntaxKeyword":
			return "\x1b[38;2;86;156;214m";
		case "syntaxString":
			return "\x1b[38;2;206;145;120m";
		case "syntaxNumber":
			return "\x1b[38;2;181;206;168m";
		case "syntaxOperator":
		case "syntaxPunctuation":
			return "\x1b[38;2;212;212;212m";
		default:
			return "";
	}
}

function hasVisibleLineContent(lines: string[]): boolean {
	return lines.some((line) => line.replace(ANSI_PATTERN, "").trim().length > 0);
}

function installEmptySelfShellRowPatch(): void {
	const proto = ToolExecutionComponent.prototype as ToolExecutionPrototype;
	if (proto[EMPTY_SELF_SHELL_ROW_PATCH]) return;
	const originalRender = proto.render;
	proto.render = function renderWithoutEmptySelfShellRows(this: ToolExecutionPrototype, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (this.getRenderShell?.() === "self" && this.hasRendererDefinition?.() && !hasVisibleLineContent(lines)) {
			return [];
		}
		return lines;
	};
	proto[EMPTY_SELF_SHELL_ROW_PATCH] = true;
}

function installUserBashRenderPatch(): void {
	const proto = BashExecutionComponent.prototype as BashExecutionPrototype;
	if (proto[USER_BASH_RENDER_PATCH]) return;
	proto.render = function renderUserBashWithoutFrame(this: BashExecutionPrototype, width: number): string[] {
		return this.contentContainer.render(width);
	};
	proto.updateDisplay = function updateUserBashDisplay(this: BashExecutionPrototype): void {
		const output = this.outputLines.join("\n");
		const running = this.status === "running";
		const failed = this.status === "error" || this.status === "cancelled";
		this.contentContainer.clear();
		this.contentContainer.addChild(
			new Text(
				renderExecCell(
					{
						kind: "user-command",
						status: running ? "running" : "done",
						command: this.command,
						failed,
					},
					{ theme: USER_BASH_RENDER_THEME, part: "header" },
				),
				1,
				0,
			),
		);

		if (output.length > 0 || !running) {
			const footerParts: string[] = [];
			if (this.status === "cancelled") footerParts.push("(cancelled)");
			if (this.status === "error") footerParts.push(`(exit ${this.exitCode})`);
			if ((this.truncationResult?.truncated || this.fullOutputPath) && this.fullOutputPath) {
				footerParts.push(`Output truncated. Full output: ${this.fullOutputPath}`);
			}
			this.contentContainer.addChild(
				new Text(
					`\n${renderExecCell(
						{
							kind: "user-command",
							status: running ? "running" : "done",
							outputBlock: {
								output,
								footer: footerParts.join("\n") || undefined,
								options: {
									expanded: this.expanded,
									maxLines: 20,
									truncatedAbove: this.truncationResult?.truncated,
								},
							},
						},
						{ theme: USER_BASH_RENDER_THEME, part: "output" },
					)}`,
					1,
					0,
				),
			);
		}

		if (running && this.loader) this.contentContainer.addChild(this.loader);
	};
	proto[USER_BASH_RENDER_PATCH] = true;
}

export function installExecCommandPiRenderPatches(): void {
	installEmptySelfShellRowPatch();
	installUserBashRenderPatch();
}
