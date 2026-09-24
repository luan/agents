import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { ComponentStack, DialogButtonBar, SelectableList, SemanticInput, tuiTheme } from "@luan.sh/pi-libtui";
import type { QuestionGroup } from "../core/state.ts";
import type { Conversation } from "../runtime/conversation.ts";

interface InlineQuestionsOptions {
	// Pi renderers expose this public method, but the shared TUI interface omits it.
	tui: Pick<TUI, "requestRender" | "setFocus"> & { getFocusedComponent?(): Component | null };
	theme: Theme;
	onAnswer(group: QuestionGroup, answers: string[], dismissed: boolean): void;
}

/** A live question card above the editor; answering never opens an overlay. */
export class InlineQuestions extends ComponentStack {
	private group: QuestionGroup | undefined;
	private index = 0;
	private answers: string[] = [];
	private input: SemanticInput | undefined;
	private choices: SelectableList<string> | undefined;
	private previousFocus: Component | null = null;
	private pendingCount = 0;

	constructor(private readonly config: InlineQuestionsOptions) {
		super();
	}

	update(groups: QuestionGroup[]): void {
		this.pendingCount = groups.length;
		if (this.group?.id !== groups[0]?.id || this.getChildren().length === 0) {
			this.blur();
			this.group = groups[0];
			this.index = 0;
			this.answers = [];
			this.rebuild();
		}
		this.config.tui.requestRender();
	}

	focus(): void {
		if (!this.group) return;
		const current = this.config.tui.getFocusedComponent?.();
		if (current === undefined) return;
		if (current !== this) this.previousFocus = current;
		this.config.tui.setFocus(this);
		this.config.tui.requestRender();
	}

	blur(): void {
		if (this.config.tui.getFocusedComponent?.() === this) this.config.tui.setFocus(this.previousFocus);
		this.previousFocus = null;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.blur();
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.setActiveChild(this.getActiveChild() === this.input && this.choices ? this.choices : this.input);
		} else super.handleInput(data);
		this.config.tui.requestRender();
	}

	private submit(answer: string): void {
		if (!this.group || !answer.trim()) return;
		this.answers[this.index] = answer.trim();
		if (this.index + 1 === this.group.questions.length) {
			this.blur();
			this.config.onAnswer(this.group, [...this.answers], false);
		} else {
			this.index++;
			this.rebuild();
		}
	}

	private rebuild(): void {
		const { tui, theme } = this.config;
		const colors = tuiTheme(theme);
		const children: Component[] = [];
		this.input = undefined;
		this.choices = undefined;
		const group = this.group;
		if (group) {
			const question = group.questions[this.index]!;
			children.push({
				render: () => [
					colors.fg(
						"accent",
						`Question ${this.index + 1}/${group.questions.length}${this.pendingCount > 1 ? ` · ${this.pendingCount} pending groups` : ""}`,
					),
				],
				invalidate() {},
			});
			children.push(new Text(theme.bold(colors.fg("text.primary", question.title)), 0, 0));
			if (question.options?.length) {
				this.choices = new SelectableList({
					items: question.options,
					maxVisible: 5,
					renderItem: (option, context) => {
						const active =
							(this.focused && this.getActiveChild() === this.choices && context.selected) || context.hovered;
						return new Text(
							colors.fg(active ? "accent" : "text.primary", `${active ? "›" : "○"} ${option}`),
							0,
							0,
						).render(context.width);
					},
					requestRender: () => tui.requestRender(),
					onActivate: (option) => this.submit(option),
				});
				children.push(this.choices);
			}
			const input = new SemanticInput(theme);
			input.placeholder = question.options?.length ? "Or type your own answer…" : "Type your answer…";
			input.setValue(this.answers[this.index] ?? "");
			input.onFocus = () => {
				this.setActiveChild(input);
				this.focus();
			};
			input.onSubmit = (value) => this.submit(value);
			input.onEscape = () => this.blur();
			this.input = input;
			children.push(input);
			children.push(
				new DialogButtonBar({
					theme,
					buttons: [
						...(this.index > 0
							? [
									{
										value: "back",
										label: "Back",
										foreground: "text.primary" as const,
										background: "action.neutral" as const,
										align: "start" as const,
									},
								]
							: []),
						{
							value: "dismiss",
							label: "Dismiss",
							foreground: "text.primary",
							background: "action.neutral",
							align: "start",
						},
						{
							value: "submit",
							label: this.index + 1 === group.questions.length ? "Send" : "Next",
							foreground: "text.primary",
							background: "action.positive",
						},
					],
					requestRender: () => tui.requestRender(),
					onActivate: (value) => {
						if (value === "dismiss") {
							this.blur();
							this.config.onAnswer(group, [], true);
						} else if (value === "back") {
							this.answers[this.index] = input.getValue();
							this.index--;
							this.rebuild();
						} else this.submit(input.getValue());
					},
				}),
			);
		}
		if (group)
			children.push({
				render: () => (this.focused ? [colors.fg("text.secondary", "Tab choices/text · Esc return to chat")] : []),
				invalidate() {},
			});
		this.setChildren(children);
		this.setActiveChild(this.choices ?? this.input);
		tui.requestRender();
	}
}

export class ConversationUI {
	private widget: InlineQuestions | undefined;
	private sessionId: string | undefined;
	constructor(private readonly conversation: Conversation) {}

	update(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const id = ctx.sessionManager.getSessionId();
		if (!this.widget || this.sessionId !== id) {
			this.dispose();
			this.sessionId = id;
			ctx.ui.setWidget("pi-conversation/questions", (tui, theme) => {
				this.widget = new InlineQuestions({
					tui,
					theme,
					onAnswer: (group, answers, dismissed) => this.conversation.answer(ctx, group, answers, dismissed),
				});
				this.widget.update(this.conversation.pending(ctx));
				return this.widget;
			});
		} else this.widget.update(this.conversation.pending(ctx));
	}

	focus(ctx: ExtensionContext): void {
		this.update(ctx);
		this.widget?.focus();
	}

	dispose(): void {
		this.widget?.blur();
		this.widget = undefined;
		this.sessionId = undefined;
	}
}
