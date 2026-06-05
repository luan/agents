import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderView } from "./renderer";
import { createSurfaceRegistry, type SurfaceContribution } from "./surfaces";
import type { RenderTheme, ViewNode } from "./types";

export interface ExtensionTuiDefinition {
	tools: ToolRegistry;
	bind(ctx: TuiSessionContext): BoundExtensionTui;
}

export interface TuiSessionContext {
	ui: {
		setWidget(
			key: string,
			content: undefined | ((tui: Pick<TUI, "requestRender">, theme: RenderTheme) => Component),
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

export interface BoundExtensionTui {
	widgets: {
		aboveEditor: {
			contribute(contribution: SurfaceContribution): void;
		};
	};
}

export interface ToolRenderContext {
	args: Record<string, unknown>;
	state?: "partial" | "ready" | "running" | "success" | "error";
	expanded?: boolean;
	result?: unknown;
}

export interface ToolRenderer {
	call?(context: ToolRenderContext): ViewNode;
	result?(context: ToolRenderContext): ViewNode;
}

export interface ToolRegistry {
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
		return renderView(node, { width, theme });
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
