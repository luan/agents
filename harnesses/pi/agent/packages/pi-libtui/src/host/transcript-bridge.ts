import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, stripTerminalSequences } from "@earendil-works/pi-tui";
import { sanitizeTuiFieldPreview } from "../content/terminal-text.ts";

export type TranscriptEntry =
	| { kind: "content"; key: object; component: Component }
	| { kind: "compaction"; key: object; component: Component; summary: string; tokensBefore: number }
	| {
			kind: "thinking";
			key: object;
			component: Component;
			summary: string;
			running: boolean;
			failed: boolean;
			timestamp?: number;
	  }
	| {
			kind: "tool";
			key: object;
			component: Component;
			summary: string;
			running: boolean;
			failed: boolean;
			toolCallId?: string;
	  };

export interface TranscriptProjection extends Component {
	dispose(): void;
}

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type AssistantOptions = ConstructorParameters<typeof AssistantMessageComponent>;
interface NativeAssistant extends Component {
	contentContainer: NativeContainer;
	lastMessage: AssistantMessage;
	isStreaming: boolean;
	markdownTheme: AssistantOptions[2];
	outputPad: number;
	markdownTransformers: NonNullable<AssistantOptions[5]>;
	updateContent: AssistantMessageComponent["updateContent"];
}
interface NativeTool extends Component {
	toolCallId: string;
	toolName: string;
	args: object;
	isPartial: boolean;
	executionStarted: boolean;
	result?: { isError: boolean };
	resultRendererComponent?: Component;
}
interface NativeContainer extends Component {
	children: Component[];
}
interface NativeCompaction extends Component {
	message: { role: "compactionSummary"; summary: string; tokensBefore: number };
}

// type-boundary: Pi 1.0 private transcript fields; the shape guards below narrow each native node before projection.
type NativeValue = unknown;
const INSTALLATION = Symbol.for("pi-libtui/transcript-projection/v1");

function record(value: NativeValue): value is Record<string, NativeValue> {
	return value !== null && typeof value === "object";
}
function component(value: NativeValue): value is Component {
	return record(value) && typeof value.render === "function" && typeof value.invalidate === "function";
}
function container(value: NativeValue): value is NativeContainer {
	return component(value) && "children" in value && Array.isArray(value.children) && value.children.every(component);
}
function assistant(value: Component): value is NativeAssistant {
	const node: NativeValue = value;
	if (!record(node) || typeof node.updateContent !== "function" || !record(node.lastMessage)) return false;
	const message = node.lastMessage;
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.every(
			(part: NativeValue) =>
				record(part) &&
				((part.type === "text" && typeof part.text === "string") ||
					(part.type === "thinking" && typeof part.thinking === "string") ||
					(part.type === "toolCall" && typeof part.name === "string")),
		) &&
		container(node.contentContainer) &&
		typeof node.isStreaming === "boolean" &&
		typeof node.outputPad === "number" &&
		record(node.markdownTheme) &&
		Array.isArray(node.markdownTransformers)
	);
}
function tool(value: Component): value is NativeTool {
	const node: NativeValue = value;
	return (
		record(node) &&
		typeof node.toolCallId === "string" &&
		typeof node.toolName === "string" &&
		record(node.args) &&
		typeof node.isPartial === "boolean" &&
		typeof node.executionStarted === "boolean" &&
		(node.result === undefined || (record(node.result) && typeof node.result.isError === "boolean")) &&
		(node.resultRendererComponent === undefined || component(node.resultRendererComponent))
	);
}

function compaction(value: Component): value is NativeCompaction {
	const message: NativeValue = Reflect.get(value, "message");
	return (
		record(message) &&
		message.role === "compactionSummary" &&
		typeof message.summary === "string" &&
		typeof message.tokensBefore === "number" &&
		Number.isFinite(message.tokensBefore) &&
		message.tokensBefore >= 0
	);
}

/** Read the latest nested semantic action without rendering its output. */
function activityLabel(node: Component, visited = new Set<Component>()): string | undefined {
	if (visited.has(node)) return undefined;
	visited.add(node);
	const getter: NativeValue = Reflect.get(node, "getActivityLabel");
	if (typeof getter === "function") {
		try {
			const label: NativeValue = Reflect.apply(getter, node, []);
			if (typeof label === "string" && label.trim()) return label;
		} catch {
			// A feature's optional summary must not break the enclosing transcript.
		}
	}
	if (container(node)) {
		for (let index = node.children.length - 1; index >= 0; index--) {
			const label = activityLabel(node.children[index]!, visited);
			if (label) return label;
		}
	}
	return undefined;
}

function toolLabel(node: NativeTool): string {
	const rendered = node.resultRendererComponent && activityLabel(node.resultRendererComponent);
	if (rendered) return sanitizeTuiFieldPreview(stripTerminalSequences(rendered), 240);
	for (const key of ["cmd", "command", "path", "query", "pattern"]) {
		const value: NativeValue = Reflect.get(node.args, key);
		if (typeof value === "string" && value.trim()) return sanitizeTuiFieldPreview(`${node.toolName}: ${value}`, 240);
	}
	return node.toolName;
}

class NativeEntries {
	private readonly assistants = new WeakMap<
		Component,
		{
			children: Component[];
			streaming: boolean;
			entries: TranscriptEntry[];
		}
	>();
	private readonly tools = new WeakMap<
		Component,
		{
			result: NativeTool["result"];
			args: object;
			partial: boolean;
			entry: TranscriptEntry;
		}
	>();

	read(node: Component): readonly TranscriptEntry[] {
		if (assistant(node)) return this.readAssistant(node);
		if (compaction(node))
			return [
				{
					kind: "compaction",
					key: node,
					component: node,
					summary: node.message.summary,
					tokensBefore: node.message.tokensBefore,
				},
			];
		if (!tool(node)) return [{ kind: "content", key: node, component: node }];
		const summary = toolLabel(node);
		const previous = this.tools.get(node);
		if (
			previous &&
			previous.result === node.result &&
			previous.args === node.args &&
			previous.partial === node.isPartial &&
			previous.entry.kind === "tool" &&
			previous.entry.summary === summary
		)
			return [previous.entry];
		const entry: TranscriptEntry = {
			kind: "tool",
			toolCallId: node.toolCallId,
			key: node,
			component: node,
			summary,
			running: !node.result || node.isPartial,
			failed: node.result?.isError ?? false,
		};
		this.tools.set(node, { result: node.result, args: node.args, partial: node.isPartial, entry });
		return [entry];
	}

	private readAssistant(node: NativeAssistant): readonly TranscriptEntry[] {
		const message = node.lastMessage;
		// Keep native error/truncation notices visible, rather than hiding them in a thought fold.
		if (["error", "aborted", "length"].includes(message.stopReason))
			return [{ kind: "content", key: node, component: node }];
		const previous = this.assistants.get(node);
		if (previous?.children === node.contentContainer.children && previous.streaming === node.isStreaming)
			return previous.entries;
		const entries: TranscriptEntry[] = [];
		for (const [index, part] of message.content.entries()) {
			if (part.type === "toolCall") continue;
			const text = part.type === "thinking" ? part.thinking : part.text;
			if (!text.trim()) continue;
			const old = previous?.entries[entries.length];
			const view =
				old?.component instanceof AssistantMessageComponent
					? old.component
					: new AssistantMessageComponent(
							undefined,
							false,
							node.markdownTheme,
							undefined,
							node.outputPad,
							node.markdownTransformers,
						);
			view.updateContent({ ...message, content: [part], stopReason: "toolUse" }, node.isStreaming);
			entries.push(
				part.type === "thinking"
					? {
							kind: "thinking",
							timestamp: Number.isFinite(message.timestamp) ? message.timestamp : undefined,
							key: view,
							component: view,
							summary: text,
							running: node.isStreaming && index === message.content.length - 1,
							failed: false,
						}
					: { kind: "content", key: view, component: view },
			);
		}
		this.assistants.set(node, { children: node.contentContainer.children, streaming: node.isStreaming, entries });
		return entries;
	}
}

/**
 * Project Pi's chat container without changing messages or its mutation targets.
 * Pi 1.0 mounts [header, resources, chat] as the first document child in
 * both modes. Fail open on another shape; replace this bridge when Pi exposes a transcript API.
 */
export function mountTranscriptProjection(
	tui: TUI,
	create: (entries: () => readonly TranscriptEntry[]) => TranscriptProjection,
): (() => void) | undefined {
	const roots: NativeValue = Reflect.get(tui, "children");
	if (!Array.isArray(roots)) return undefined;
	const document: NativeValue = roots[0];
	if (!container(document) || document.children.length !== 3 || !document.children.every(container)) return undefined;
	if (Reflect.get(document, INSTALLATION)) return undefined;
	const source = document.children[2]!;
	if (!container(source)) return undefined;
	const reader = new NativeEntries();
	const projection = create(() =>
		source.children.flatMap((child): readonly TranscriptEntry[] =>
			tui.mode === "fullscreen" ? reader.read(child) : [{ kind: "content", key: child, component: child }],
		),
	);
	const children: Component[] = document.children;
	children[2] = projection;
	Reflect.set(document, INSTALLATION, projection);
	tui.requestRender();
	return () => {
		if (document.children[2] === projection) document.children[2] = source;
		if (Reflect.get(document, INSTALLATION) === projection) Reflect.deleteProperty(document, INSTALLATION);
		projection.dispose();
		tui.requestRender();
	};
}
