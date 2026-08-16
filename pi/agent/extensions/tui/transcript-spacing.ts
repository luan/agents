import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Component } from "@earendil-works/pi-tui";
import { paintHalfHeightBackgroundEdges } from "../shared/tui/text.ts";

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
type StackEntry = { component: Component; minSize?: number };
type LayoutStack = Component & { entries?: StackEntry[] };
type InteractiveModeInstance = {
	chatContainer?: ChatContainer;
	editorContainer?: Component;
	fullscreenLayoutRoot?: LayoutStack;
	widgetContainerAbove?: { children: Component[] };
};
type RenderWidgets = (this: InteractiveModeInstance) => void;
type SetExtensionFooter = (this: InteractiveModeInstance, factory: unknown) => void;
type InteractiveModePrototype = {
	renderWidgets: RenderWidgets;
	setExtensionFooter: SetExtensionFooter;
};
type PatchState = {
	prototype: InteractiveModePrototype;
	originalRenderWidgets: RenderWidgets;
	wrappedRenderWidgets: RenderWidgets;
	originalSetFooter: SetExtensionFooter;
	wrappedSetFooter: SetExtensionFooter;
	users: number;
};
type LegacyPatchState = {
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
const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: PatchState | LegacyPatchState };

// Assistant messages are re-filtered on every animation frame, and stripping escapes
// allocates a copy of each line. Rendered lines are stable strings, so answer from a
// bounded cache instead. Mirrors pi-tui's own string-keyed width cache.
const BLANK_CACHE_LIMIT = 4096;
const blankCache = new Map<string, boolean>();

function isBlank(line: string): boolean {
	const cached = blankCache.get(line);
	if (cached !== undefined) return cached;
	const blank = line.replace(ANSI_ESCAPE, "").replace(OSC_ESCAPE, "").trim().length === 0;
	if (blankCache.size >= BLANK_CACHE_LIMIT) {
		const oldest = blankCache.keys().next().value;
		if (oldest !== undefined) blankCache.delete(oldest);
	}
	blankCache.set(line, blank);
	return blank;
}

// Tested once per assistant component per animation frame. trim() would allocate a copy
// of the whole thinking block each time; this scans to the first non-whitespace character.
const NON_WHITESPACE = /\S/;

function hasThinking(component: TranscriptComponent): boolean {
	return Boolean(
		component.lastMessage?.content?.some(
			(block) => block.type === "thinking" && block.thinking && NON_WHITESPACE.test(block.thinking),
		),
	);
}

function removeBlankLines(lines: string[], all: boolean): string[] {
	if (lines.length === 0) return lines;
	const prefix = lines[0]?.match(OSC_PREFIX)?.[0] ?? "";
	const compact = all ? lines.filter((line) => !isBlank(line)) : isBlank(lines[0] ?? "") ? lines.slice(1) : lines;
	if (prefix && compact.length > 0 && !compact[0]?.startsWith(prefix)) compact[0] = prefix + compact[0];
	return compact;
}

function patchComponent(component: TranscriptComponent): void {
	component[ORIGINAL_RENDER] ??= component.render;
	const original = component[ORIGINAL_RENDER];
	const name = component.constructor.name;
	component.render = function (width) {
		const lines = original.call(this, width);
		if (USER_COMPONENTS.has(name)) {
			return paintHalfHeightBackgroundEdges(lines, width);
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

export function relaxFullscreenEditorSize(instance: InteractiveModeInstance): void {
	const editor = instance.editorContainer;
	const dock = instance.fullscreenLayoutRoot?.entries
		?.map((entry) => entry.component as LayoutStack)
		.find((component) => component.entries?.some((entry) => entry.component === editor));
	const editorEntry = dock?.entries?.find((entry) => entry.component === editor);
	if (editorEntry) editorEntry.minSize = 2;
}

function patchInstance(instance: InteractiveModeInstance): void {
	const aboveEditor = instance.widgetContainerAbove;
	if (aboveEditor?.children[0]?.constructor.name === "Spacer") aboveEditor.children.shift();
	relaxFullscreenEditorSize(instance);

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
	if (
		existing &&
		"wrappedRenderWidgets" in existing &&
		existing.prototype.renderWidgets === existing.wrappedRenderWidgets &&
		existing.prototype.setExtensionFooter === existing.wrappedSetFooter
	) {
		existing.users++;
		return () => releasePatch(existing);
	}

	const originalRenderWidgets = prototype.renderWidgets;
	const wrappedRenderWidgets: RenderWidgets = function () {
		originalRenderWidgets.call(this);
		patchInstance(this);
	};
	const originalSetFooter = prototype.setExtensionFooter;
	const wrappedSetFooter: SetExtensionFooter = function (factory) {
		originalSetFooter.call(this, factory);
		relaxFullscreenEditorSize(this);
	};
	const state: PatchState = {
		prototype,
		originalRenderWidgets,
		wrappedRenderWidgets,
		originalSetFooter,
		wrappedSetFooter,
		users: 1,
	};
	prototype.renderWidgets = wrappedRenderWidgets;
	prototype.setExtensionFooter = wrappedSetFooter;
	globalState[PATCH_KEY] = state;
	return () => releasePatch(state);
}

function removeCurrentPatch(prototype: InteractiveModePrototype): void {
	const existing = globalState[PATCH_KEY];
	if (!existing) return;
	if ("wrappedRenderWidgets" in existing) {
		if (prototype.renderWidgets === existing.wrappedRenderWidgets) {
			prototype.renderWidgets = existing.originalRenderWidgets;
		}
		if (prototype.setExtensionFooter === existing.wrappedSetFooter) {
			prototype.setExtensionFooter = existing.originalSetFooter;
		}
	} else if (prototype.renderWidgets === existing.wrapped) {
		prototype.renderWidgets = existing.original;
	}
	delete globalState[PATCH_KEY];
}

function removeLegacyTransitionPatch(prototype: InteractiveModePrototype): void {
	const legacy = (
		globalThis as typeof globalThis & {
			[LEGACY_PATCH_KEY]?: LegacyPatchState;
		}
	)[LEGACY_PATCH_KEY];
	if (!legacy) return;
	if (prototype.renderWidgets === legacy.wrapped) prototype.renderWidgets = legacy.original;
	delete (
		globalThis as typeof globalThis & {
			[LEGACY_PATCH_KEY]?: LegacyPatchState;
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
	if (state.prototype.renderWidgets === state.wrappedRenderWidgets) {
		state.prototype.renderWidgets = state.originalRenderWidgets;
	}
	if (state.prototype.setExtensionFooter === state.wrappedSetFooter) {
		state.prototype.setExtensionFooter = state.originalSetFooter;
	}
	if (globalState[PATCH_KEY] === state) delete globalState[PATCH_KEY];
}
