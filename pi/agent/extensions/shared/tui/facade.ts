import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderView } from "./renderer";
import { createSurfaceRegistry, type SurfaceContribution } from "./surfaces";
import type { RenderTheme, ViewNode } from "./types";

type WidgetTui = Pick<TUI, "requestRender">;

interface ExtensionTuiDefinition {
	tools: ToolRegistry;
	bind(ctx: TuiSessionContext): BoundExtensionTui;
}

interface OverlayHostOptions {
	overlay?: boolean;
	overlayOptions?: unknown;
}

interface TuiSessionContext {
	ui: {
		setWidget(
			key: string,
			content: undefined | ((tui: WidgetTui, theme: RenderTheme) => Component),
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		custom?<T>(
			factory: (tui: TUI, theme: RenderTheme, keybindings: unknown, done: (value: T) => void) => Component,
			options?: OverlayHostOptions,
		): Promise<T>;
		setStatus?(key: string, text: string | undefined): void;
		setFooter?(factory: unknown): void;
		setEditorComponent?(factory: unknown): void;
	};
}

interface BoundExtensionTui {
	widgets: {
		aboveEditor: {
			contribute(contribution: SurfaceContribution): void;
		};
	};
	overlays: {
		openComponent<T>(
			factory: (tui: TUI, theme: RenderTheme, keybindings: unknown, done: (value: T) => void) => Component,
			options?: OverlayHostOptions,
		): Promise<T>;
	};
	status: {
		set(key: string, text: string): void;
		clear(key: string): void;
	};
	footer: {
		replace(factory: unknown): void;
		clear(): void;
	};
	editor: {
		replace(factory: unknown): void;
		clear(): void;
	};
}

export interface ToolRenderContext {
	args: Record<string, unknown>;
	state?: "partial" | "ready" | "running" | "success" | "error";
	expanded?: boolean;
	result?: unknown;
}

interface ToolRenderer {
	call?(context: ToolRenderContext): ViewNode;
	result?(context: ToolRenderContext): ViewNode;
}

interface ToolRegistry {
	register(name: string, renderer: ToolRenderer): void;
	resolve(name: string): ToolRenderer | undefined;
}

export function defineExtensionTui(options: { id: string }): ExtensionTuiDefinition {
	const tools = new ToolRegistryImpl();
	return {
		tools,
		bind(ctx) {
			return new BoundExtensionTuiImpl(options.id, ctx);
		},
	};
}

class BoundExtensionTuiImpl implements BoundExtensionTui {
	private surfaces = createSurfaceRegistry();

	constructor(
		private readonly extensionId: string,
		private readonly ctx: TuiSessionContext,
	) {}

	widgets = {
		aboveEditor: {
			contribute: (contribution: SurfaceContribution) => {
				this.surfaces.contribute("widgets.aboveEditor", contribution);
				this.mountWidget("widgets.aboveEditor", "aboveEditor");
			},
		},
	};

	overlays = {
		openComponent: <T>(
			factory: (tui: TUI, theme: RenderTheme, keybindings: unknown, done: (value: T) => void) => Component,
			options: OverlayHostOptions = { overlay: true },
		): Promise<T> => {
			if (!this.ctx.ui.custom) throw new Error("ctx.ui.custom is unavailable for overlay Host Surface");
			return this.ctx.ui.custom(factory, {
				overlay: options.overlay ?? true,
				overlayOptions: options.overlayOptions,
			});
		},
	};

	status = {
		set: (key: string, text: string): void => {
			this.setStatus(key, text);
		},
		clear: (key: string): void => {
			this.setStatus(key, undefined);
		},
	};

	footer = {
		replace: (factory: unknown): void => {
			if (!this.ctx.ui.setFooter) throw new Error("ctx.ui.setFooter is unavailable for footer Host Surface");
			this.ctx.ui.setFooter(factory);
		},
		clear: (): void => {
			if (!this.ctx.ui.setFooter) throw new Error("ctx.ui.setFooter is unavailable for footer Host Surface");
			this.ctx.ui.setFooter(undefined);
		},
	};

	editor = {
		replace: (factory: unknown): void => {
			if (!this.ctx.ui.setEditorComponent) {
				throw new Error("ctx.ui.setEditorComponent is unavailable for editor Host Surface");
			}
			this.ctx.ui.setEditorComponent(factory);
		},
		clear: (): void => {
			if (!this.ctx.ui.setEditorComponent) {
				throw new Error("ctx.ui.setEditorComponent is unavailable for editor Host Surface");
			}
			this.ctx.ui.setEditorComponent(undefined);
		},
	};

	private setStatus(key: string, text: string | undefined): void {
		if (!this.ctx.ui.setStatus) throw new Error("ctx.ui.setStatus is unavailable for status Host Surface");
		this.ctx.ui.setStatus(`${this.extensionId}:${key}`, text);
	}

	private mountWidget(surface: string, placement: "aboveEditor" | "belowEditor"): void {
		const key = `${this.extensionId}:${surface}`;
		this.ctx.ui.setWidget(
			key,
			(_tui, theme) =>
				new ViewComponent(() => ({
					node: {
						kind: "stack",
						children: this.surfaces
							.resolveShared(surface)
							.map((entry) => (typeof entry.view === "function" ? entry.view() : entry.view)),
					},
					theme,
				})),
			{ placement },
		);
	}
}

class ViewComponent implements Component {
	constructor(private readonly snapshot: () => { node: ViewNode; theme: RenderTheme }) {}

	render(width: number): string[] {
		const { node, theme } = this.snapshot();
		return renderView(node, { width, theme, background: "customMessageBg" });
	}

	invalidate(): void {}
}

class ToolRegistryImpl implements ToolRegistry {
	private renderers = new Map<string, ToolRenderer>();

	register(name: string, renderer: ToolRenderer): void {
		this.renderers.set(name, renderer);
	}

	resolve(name: string): ToolRenderer | undefined {
		return this.renderers.get(name);
	}
}
