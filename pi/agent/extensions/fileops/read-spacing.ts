import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type ToolComponent = {
	toolName?: string;
	render(width: number): string[];
};
type ChatContainer = {
	children: ToolComponent[];
	render(width: number): string[];
};
type InteractiveMode = { chatContainer?: ChatContainer };
type RenderWidgetContainer = (this: InteractiveMode, ...args: unknown[]) => void;
type InteractiveModePrototype = { renderWidgetContainer: RenderWidgetContainer };
type PatchState = {
	prototype: InteractiveModePrototype;
	original: RenderWidgetContainer;
	wrapped: RenderWidgetContainer;
	chats: Map<ChatContainer, ChatContainer["render"]>;
	tools: Map<ToolComponent, ToolComponent["render"]>;
	users: number;
};

const PATCH_KEY = Symbol.for("agents.fileops.consecutiveReadSpacingPatch");
const SUPPRESS_SPACER = Symbol.for("agents.fileops.suppressReadSpacer");
const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };

type PatchedTool = ToolComponent & { [SUPPRESS_SPACER]?: boolean };
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function patchConsecutiveReadSpacing(prototype: InteractiveModePrototype): () => void {
	const existing = globalState[PATCH_KEY];
	if (existing && existing.prototype.renderWidgetContainer === existing.wrapped) {
		existing.users++;
		return () => releasePatch(existing);
	}

	const original = prototype.renderWidgetContainer;
	const state: PatchState = { prototype, original, wrapped: original, chats: new Map(), tools: new Map(), users: 1 };
	const wrapped: RenderWidgetContainer = function (...args) {
		original.apply(this, args);
		if (this.chatContainer) patchChatContainer(this.chatContainer, state);
	};
	state.wrapped = wrapped;
	prototype.renderWidgetContainer = wrapped;
	globalState[PATCH_KEY] = state;
	return () => releasePatch(state);
}

export async function installConsecutiveReadSpacingPatch(): Promise<() => void> {
	const cliPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
	const interactivePath = join(dirname(cliPath), "modes", "interactive", "interactive-mode.js");
	if (!existsSync(interactivePath)) return () => {};
	const module = (await import(pathToFileURL(interactivePath).href)) as {
		InteractiveMode?: { prototype: InteractiveModePrototype };
	};
	return module.InteractiveMode ? patchConsecutiveReadSpacing(module.InteractiveMode.prototype) : () => {};
}

function rendersVisibleContent(component: ToolComponent, width: number): boolean {
	return component.render(width).some((line) => line.replace(ANSI_ESCAPE, "").length > 0);
}

function patchChatContainer(chat: ChatContainer, state: PatchState): void {
	if (state.chats.has(chat)) return;
	const originalRender = chat.render;
	state.chats.set(chat, originalRender);
	chat.render = function (width) {
		let previousRead = false;
		for (const child of this.children) {
			const isRead = child.toolName === "read";
			const patched = child as PatchedTool;
			patched[SUPPRESS_SPACER] = isRead && previousRead;
			if (isRead) {
				if (!state.tools.has(child)) patchToolComponent(child, state);
				previousRead = true;
				continue;
			}
			if (child.toolName !== undefined || rendersVisibleContent(child, width)) {
				previousRead = false;
			}
		}
		return originalRender.call(this, width);
	};
}

function patchToolComponent(tool: ToolComponent, state: PatchState): void {
	const originalRender = tool.render;
	state.tools.set(tool, originalRender);
	tool.render = function (width) {
		const lines = originalRender.call(this, width);
		return (this as PatchedTool)[SUPPRESS_SPACER] && lines[0] === "" ? lines.slice(1) : lines;
	};
}

function releasePatch(state: PatchState): void {
	state.users--;
	if (state.users > 0) return;
	if (state.prototype.renderWidgetContainer === state.wrapped) state.prototype.renderWidgetContainer = state.original;
	for (const [chat, render] of state.chats) chat.render = render;
	for (const [tool, render] of state.tools) tool.render = render;
	if (globalState[PATCH_KEY] === state) delete globalState[PATCH_KEY];
}
