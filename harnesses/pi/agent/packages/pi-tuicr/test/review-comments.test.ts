import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dispatchEditorRender, ensureEditorRegistry } from "pi-libtui/editor";
import type { OverlayMouseRegion, ScreenDecoratorRegistration } from "pi-libtui/mouse";
import { ReviewCommentAttachments } from "../src/review-comments.ts";

const theme = {
	name: "review-comments-test",
	bold: (text: string) => text,
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

test("renders live review comments as one editor pill and expands them on submit", () => {
	let editorText = "Please fix these";
	const context = {
		ui: {
			theme,
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	} as never;
	const registry = ensureEditorRegistry(Object.create(null) as typeof globalThis);
	let tooltipRegion: OverlayMouseRegion | undefined;
	let tooltipDecorator: ScreenDecoratorRegistration | undefined;
	const mouseRegistry = {
		registerOverlayRegion: (region: OverlayMouseRegion) => {
			tooltipRegion = region;
			return () => {};
		},
		registerScreenDecorator: (decorator: ScreenDecoratorRegistration) => {
			tooltipDecorator = decorator;
			return () => {};
		},
	} as never;
	const attachments = new ReviewCommentAttachments(context, registry, mouseRegistry);

	attachments.publish([
		{ id: "draft", content: "   ", location: "src/draft.ts:1" },
		{ id: "one", content: "First issue", location: "src/one.ts:4" },
		{ id: "two", content: "Second issue", path: "src/two.ts" },
	]);
	attachments.publish([{ id: "one", content: "Updated first issue", location: "src/one.ts:4" }]);
	const rendered = Bun.stripANSI(dispatchEditorRender(registry, [editorText], 80).join("\n"));
	expect(rendered).toContain("");
	expect(rendered).toContain("2 review comments");
	const screen = dispatchEditorRender(registry, [editorText, "", "", "", "", "", "", ""], 80);
	const decorationContext = { width: 80, height: 8, hasOverlay: false } as const;
	tooltipDecorator?.decorate([...screen], decorationContext);
	expect(tooltipRegion?.getRect()).toBeDefined();
	tooltipRegion?.onMouse({
		type: "move",
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});
	const withTooltip = Bun.stripANSI((tooltipDecorator?.decorate([...screen], decorationContext) ?? screen).join("\n"));
	expect(withTooltip).toContain("Updated first issue");
	expect(withTooltip).toContain("Second issue");

	const transformed = attachments.transform(editorText);
	expect(transformed).toContain("I reviewed your changes. Please address these comments:");
	expect(transformed).toContain("`src/one.ts:4` - Updated first issue");
	expect(transformed).toContain("`src/two.ts` - Second issue");

	editorText = "";
	attachments.accept({ role: "user", content: transformed });
	expect(Bun.stripANSI(dispatchEditorRender(registry, [editorText], 80).join("\n"))).not.toContain("review comments");
	attachments.dispose();
});

test("removes its private editor atom when disposed before submission", () => {
	let editorText = "draft";
	const context = {
		ui: {
			theme,
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	} as never;
	const attachments = new ReviewCommentAttachments(
		context,
		ensureEditorRegistry(Object.create(null) as typeof globalThis),
		{
			registerOverlayRegion: () => () => {},
			registerScreenDecorator: () => () => {},
		} as never,
	);
	attachments.publish([{ id: "one", content: "Issue" }]);
	attachments.dispose();
	expect(editorText).toBe("draft");
});
