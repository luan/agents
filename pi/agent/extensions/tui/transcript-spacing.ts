import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Component } from "@earendil-works/pi-tui";

type ContentBlock = { type: string; thinking?: string };
type TranscriptComponent = Component & {
	lastMessage?: { content?: ContentBlock[] };
	render(width: number): string[];
	[ORIGINAL_RENDER]?: TranscriptComponent["render"];
	[SUPPRESS_LEADING]?: boolean;
};
type AddChild = (component: TranscriptComponent) => void;
type ChatContainer = {
	children: TranscriptComponent[];
	addChild?: AddChild;
	[ORIGINAL_ADD_CHILD]?: AddChild;
};
type InteractiveModeInstance = {
	chatContainer?: ChatContainer;
	widgetContainerAbove?: { children: Component[] };
};
type RenderWidgets = (this: InteractiveModeInstance) => void;
type InteractiveModePrototype = { renderWidgets: RenderWidgets };
type PatchState = {
	prototype: InteractiveModePrototype;
	original: RenderWidgets;
	wrapped: RenderWidgets;
	users: number;
};

const PATCH_KEY = Symbol.for("agents.polishedTui.transcriptSpacingPatch");
const LEGACY_PATCH_KEY = Symbol.for("agents.polishedTui.interactiveTransitionPatch");
const ORIGINAL_RENDER = Symbol.for("agents.polishedTui.transcriptOriginalRender");
const ORIGINAL_ADD_CHILD = Symbol.for("agents.polishedTui.transcriptOriginalAddChild");
const SUPPRESS_LEADING = Symbol.for("agents.polishedTui.suppressLeadingSpacer");
const USER_COMPONENTS = new Set(["UserMessageComponent", "SkillInvocationMessageComponent"]);
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PREFIX = /^(?:\x1b]133;[ABC]\x07)*/;
const OSC_ESCAPE = /\x1b]133;[ABC]\x07/g;
const BACKGROUND = /\x1b\[48(?:;[0-9]+)*m/;
const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState };

function isBlank(line: string): boolean {
	return line.replace(ANSI_ESCAPE, "").replace(OSC_ESCAPE, "").trim().length === 0;
}

function hasThinking(component: TranscriptComponent): boolean {
	return Boolean(component.lastMessage?.content?.some((block) => block.type === "thinking" && block.thinking?.trim()));
}

function removeBlankLines(lines: string[], all: boolean): string[] {
	if (lines.length === 0) return lines;
	const prefix = lines[0]?.match(OSC_PREFIX)?.[0] ?? "";
	const compact = all ? lines.filter((line) => !isBlank(line)) : isBlank(lines[0] ?? "") ? lines.slice(1) : lines;
	if (prefix && compact.length > 0 && !compact[0]?.startsWith(prefix)) compact[0] = prefix + compact[0];
	return compact;
}

function halfBackground(line: string, glyph: "▄" | "▀", width: number): string {
	const background = line.match(BACKGROUND)?.[0];
	if (!background) return line;
	const prefix = line.match(OSC_PREFIX)?.[0] ?? "";
	return `${prefix}${background.replace("[48", "[38")}${glyph.repeat(width)}\x1b[39m`;
}

function patchComponent(component: TranscriptComponent): void {
	component[ORIGINAL_RENDER] ??= component.render;
	const original = component[ORIGINAL_RENDER];
	const name = component.constructor.name;
	component.render = function (width) {
		const lines = original.call(this, width);
		if (USER_COMPONENTS.has(name)) {
			if (lines.length < 2) return lines;
			lines[0] = halfBackground(lines[0] ?? "", "▄", width);
			lines[lines.length - 1] = halfBackground(lines.at(-1) ?? "", "▀", width);
			return lines;
		}
		if (name !== "AssistantMessageComponent") return lines;
		if (hasThinking(this)) return removeBlankLines(lines, true);
		return this[SUPPRESS_LEADING] ? removeBlankLines(lines, false) : lines;
	};
}

function patchTranscript(container: ChatContainer): void {
	for (let index = container.children.length - 1; index > 0; index--) {
		const name = container.children[index]?.constructor.name ?? "";
		if (USER_COMPONENTS.has(name) && container.children[index - 1]?.constructor.name === "Spacer") {
			container.children.splice(index - 1, 1);
		}
	}

	let previousName = "";
	for (const child of container.children) {
		const name = child.constructor.name;
		if (name === "Spacer") continue;
		child[SUPPRESS_LEADING] = name === "AssistantMessageComponent" && USER_COMPONENTS.has(previousName);
		patchComponent(child);
		previousName = name;
	}
}

function patchInstance(instance: InteractiveModeInstance): void {
	const aboveEditor = instance.widgetContainerAbove;
	if (aboveEditor?.children[0]?.constructor.name === "Spacer") aboveEditor.children.shift();

	const container = instance.chatContainer;
	if (!container) return;
	patchTranscript(container);
	if (!container.addChild) return;
	container[ORIGINAL_ADD_CHILD] ??= container.addChild;
	const original = container[ORIGINAL_ADD_CHILD];
	container.addChild = function (component) {
		original.call(this, component);
		patchTranscript(this);
	};
}

function patchPrototype(prototype: InteractiveModePrototype): () => void {
	const existing = globalState[PATCH_KEY];
	if (existing && existing.prototype.renderWidgets === existing.wrapped) {
		existing.users++;
		return () => releasePatch(existing);
	}

	const original = prototype.renderWidgets;
	const wrapped: RenderWidgets = function () {
		original.call(this);
		patchInstance(this);
	};
	const state: PatchState = { prototype, original, wrapped, users: 1 };
	prototype.renderWidgets = wrapped;
	globalState[PATCH_KEY] = state;
	return () => releasePatch(state);
}

function removeCurrentPatch(prototype: InteractiveModePrototype): void {
	const existing = globalState[PATCH_KEY];
	if (!existing) return;
	if (prototype.renderWidgets === existing.wrapped) prototype.renderWidgets = existing.original;
	delete globalState[PATCH_KEY];
}

function removeLegacyTransitionPatch(prototype: InteractiveModePrototype): void {
	const legacy = (
		globalThis as typeof globalThis & {
			[LEGACY_PATCH_KEY]?: PatchState;
		}
	)[LEGACY_PATCH_KEY];
	if (!legacy) return;
	if (prototype.renderWidgets === legacy.wrapped) prototype.renderWidgets = legacy.original;
	delete (
		globalThis as typeof globalThis & {
			[LEGACY_PATCH_KEY]?: PatchState;
		}
	)[LEGACY_PATCH_KEY];
}

export async function installTranscriptSpacingPatch(): Promise<() => void> {
	const cliPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
	const interactivePath = join(dirname(cliPath), "modes", "interactive", "interactive-mode.js");
	if (!existsSync(interactivePath)) return () => {};
	const module = (await import(pathToFileURL(interactivePath).href)) as {
		InteractiveMode?: { prototype: InteractiveModePrototype };
	};
	if (!module.InteractiveMode) return () => {};
	removeCurrentPatch(module.InteractiveMode.prototype);
	removeLegacyTransitionPatch(module.InteractiveMode.prototype);
	return patchPrototype(module.InteractiveMode.prototype);
}

function releasePatch(state: PatchState): void {
	state.users--;
	if (state.users > 0) return;
	if (state.prototype.renderWidgets === state.wrapped) state.prototype.renderWidgets = state.original;
	if (globalState[PATCH_KEY] === state) delete globalState[PATCH_KEY];
}
