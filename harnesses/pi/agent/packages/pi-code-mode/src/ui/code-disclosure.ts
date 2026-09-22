import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { ComponentStack, icon, SyntaxText, sanitizeTuiField, TabBar, tuiTheme } from "@luan.sh/pi-libtui";
import { ToolActivity } from "@luan.sh/pi-libtui/tool";

/** Delay syntax setup until compact result content is actually visible. */
export class LazyCodeModeResult implements Component {
	private result: SyntaxText | undefined;

	constructor(
		private readonly theme: Theme,
		private text: string,
		private readonly requestRender: () => void,
	) {}

	update(text: string): void {
		this.text = text;
		this.result?.setText(prettify(text));
	}

	render(width: number): string[] {
		return this.ensureResult().render(width);
	}

	invalidate(): void {
		this.result?.invalidate();
	}

	dispose(): void {
		this.result?.invalidate();
		this.result = undefined;
	}

	private ensureResult(): SyntaxText {
		this.result ??= new SyntaxText({
			theme: this.theme,
			text: prettify(this.text),
			path: ".json",
			maxRows: 1_000,
			requestRender: this.requestRender,
		});
		return this.result;
	}
}

export interface CodeDisclosureView {
	tool: "exec" | "wait";
	code: string;
	result: string;
	meta?: string;
	initialMode?: string;
}

export class CodeModeDisclosure implements Component {
	private readonly activity: ToolActivity;
	private readonly action: CodeModeAction;
	private readonly nestedBody = new ComponentStack();
	private readonly body = new ComponentStack();
	private tabs: LazyCodeModeTabs | undefined;
	private view: CodeDisclosureView;

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		view: CodeDisclosureView,
	) {
		this.view = view;
		this.action = new CodeModeAction(theme, view);
		this.updateBody([]);
		this.activity = new ToolActivity({
			theme,
			requestRender,
			maxHeight: 20,
			action: this.action,
			view: this.activityView(),
		});
	}

	update(view: CodeDisclosureView, nested: readonly Component[] = []): void {
		this.view = view;
		this.action.update(view);
		this.updateBody(nested);
		this.activity.update(this.activityView(), this.action);
	}

	render(width: number): string[] {
		return this.activity.render(width);
	}
	get children() {
		return this.activity.children;
	}

	invalidate(): void {
		this.activity.invalidate();
	}

	dispose(): void {
		this.activity.dispose();
		this.tabs?.dispose();
	}

	private activityView() {
		const hasDetails = this.body.getChildren().length > 0;
		const full = this.tabs ? this.body : undefined;
		return {
			action: { verb: codeModeLabel(this.view), status: "succeeded" as const, marker: false as const },
			payload: hasDetails
				? {
						kind: "component" as const,
						preview: this.nestedBody,
						...(full ? { full } : {}),
					}
				: undefined,
			mode: this.view.initialMode === "details" && full ? ("full" as const) : ("preview" as const),
		};
	}

	private updateBody(nested: readonly Component[]): void {
		if (this.view.code || this.view.result) {
			if (this.tabs) this.tabs.update(this.view.code, this.view.result);
			else this.tabs = new LazyCodeModeTabs(this.theme, this.view.code, this.view.result, this.requestRender);
		} else if (this.tabs) {
			this.tabs.dispose();
			this.tabs = undefined;
		}
		this.nestedBody.setChildren(nested);
		this.body.setChildren(this.tabs ? [this.tabs, ...nested] : nested);
	}
}

/** Delay both Shiki construction and rendering until the details tab is visible. */
class LazyCodeModeTabs implements Component {
	private tabs: CodeModeTabs | undefined;

	constructor(
		private readonly theme: Theme,
		private code: string,
		private result: string,
		private readonly requestRender: () => void,
	) {}

	update(code: string, result: string): void {
		this.code = code;
		this.result = result;
		this.tabs?.update(code, result);
	}

	render(width: number): string[] {
		return this.ensureTabs().render(width);
	}

	handleInput(data: string): boolean {
		return this.tabs?.handleInput(data) ?? false;
	}

	onMouse(event: Parameters<TabBar["onMouse"]>[0]): boolean {
		return this.tabs?.onMouse(event) ?? false;
	}

	invalidate(): void {
		this.tabs?.invalidate();
	}

	dispose(): void {
		this.tabs?.invalidate();
		this.tabs = undefined;
	}

	private ensureTabs(): CodeModeTabs {
		if (!this.tabs) this.tabs = new CodeModeTabs(this.theme, this.code, this.result, this.requestRender);
		return this.tabs;
	}
}

class CodeModeAction implements Component {
	constructor(
		private readonly theme: Theme,
		private view: CodeDisclosureView,
	) {}

	update(view: CodeDisclosureView): void {
		this.view = view;
	}

	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		return [
			colors.fg(
				"text.muted",
				truncateToWidth(`${icon("code-mode")} ${codeModeLabel(this.view)}`, Math.max(0, width), "…"),
			),
		];
	}

	invalidate(): void {}
}

class CodeModeTabs implements Component {
	private readonly tabs: TabBar;
	private active = 0;
	private readonly code: SyntaxText;
	private readonly result: SyntaxText;
	private renderedWidth = -1;
	private knownContentHeight = 0;
	private cached: { active: number; content: string[]; lines: string[] } | undefined;

	constructor(theme: Theme, code: string, result: string, requestRender: () => void) {
		this.code = new SyntaxText({
			theme,
			text: code || "(no code)",
			path: ".js",
			maxRows: 500,
			requestRender,
		});
		this.result = new SyntaxText({
			theme,
			text: result ? prettify(result) : "(no result)",
			path: ".json",
			maxRows: 1_000,
			requestRender,
		});
		this.tabs = new TabBar(
			[
				{ id: "code", label: "Code" },
				{ id: "result", label: "Result" },
			],
			theme,
		);
		this.tabs.onChange = (_tab, index) => {
			this.active = index;
			this.cached = undefined;
			requestRender();
		};
	}

	update(code: string, result: string): void {
		this.code.setText(code || "(no code)");
		this.result.setText(result ? prettify(result) : "(no result)");
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.renderedWidth !== width) {
			this.knownContentHeight = 0;
			this.cached = undefined;
			this.renderedWidth = width;
		}
		const active = this.active === 0 ? this.code.render(width) : this.result.render(width);
		this.knownContentHeight = Math.max(this.knownContentHeight, active.length);
		if (this.cached?.active === this.active && this.cached.content === active) return this.cached.lines;
		const lines = [
			...this.tabs.render(width),
			...active,
			...Array.from({ length: this.knownContentHeight - active.length }, () => ""),
		];
		this.cached = { active: this.active, content: active, lines };
		return lines;
	}

	handleInput(data: string): boolean {
		return this.tabs.handleInput(data);
	}

	onMouse(event: Parameters<TabBar["onMouse"]>[0]): boolean {
		return event.row === 0 ? this.tabs.onMouse(event) : false;
	}

	invalidate(): void {
		this.tabs.invalidate();
		this.code.invalidate();
		this.result.invalidate();
		this.knownContentHeight = 0;
		this.renderedWidth = -1;
		this.cached = undefined;
	}
}

function codeModeLabel(view: CodeDisclosureView): string {
	return `Code Mode · ${view.tool}${view.meta ? ` · ${sanitizeTuiField(view.meta)}` : ""}`;
}

function prettify(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}
