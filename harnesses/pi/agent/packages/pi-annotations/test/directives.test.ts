import { describe, expect, test } from "bun:test";
import { projectAnnotationDirectives } from "../src/core/directives.ts";
import { AnnotationPresentationGroups } from "../src/core/presentation.ts";
import { AnnotationStore } from "../src/core/store.ts";
import { serializeEnvelope } from "../src/core/envelope.ts";
import type { AnnotationSelection } from "../src/core/types.ts";

describe("annotation directives", () => {
	test("accepts Pi and imported Codex names with a turn key", () => {
		expect(projectAnnotationDirectives(':pi-annotation{index="1"} :codex-annotation{index="2"}', 2, "turn-a")).toBe(
			"[1] [2]",
		);
	});

	test("leaves invalid names, zero, and out-of-range indices as text", () => {
		const source = ':other-annotation{index="1"} :pi-annotation{index="0"} :pi-annotation{index="2"}';
		expect(projectAnnotationDirectives(source, 1)).toBe(source);
	});

	test("ignores directives in inline and fenced code", () => {
		const directive = ':pi-annotation{index="1"}';
		const source = `\`${directive}\`\n\`\`\`text\n${directive}\n\`\`\`\n${directive}`;
		expect(projectAnnotationDirectives(source, 1, "t")).toBe(`\`${directive}\`\n\`\`\`text\n${directive}\n\`\`\`\n[1]`);
	});

	test("different turn keys produce disjoint URLs", () => {
		const directive = ':pi-annotation{index="1"}';
		expect(projectAnnotationDirectives(directive, 1, "old", (_index, url) => url)).not.toBe(
			projectAnnotationDirectives(directive, 1, "new", (_index, url) => url),
		);
	});

	test("supports clean pill projection without visible Markdown URL syntax", () => {
		const rendered = projectAnnotationDirectives(
			':pi-annotation{index="1"}',
			1,
			"turn",
			(index, url) => `PILL(${index},${url})`,
		);
		expect(rendered).toBe("PILL(1,pi-annotation://show/turn/1)");
		expect(rendered).not.toContain("](");
	});

	test("old assistant links keep their own turn annotations after newer turns render", () => {
		const selection: AnnotationSelection = {
			messageId: "m",
			messageIdStability: "stable",
			text: "old text",
			shape: "character",
			start: { row: 0, col: 0 },
			end: { row: 0, col: 1 },
			screenStart: { row: 0, col: 0 },
			screenEnd: { row: 0, col: 1 },
		};
		const groups = new AnnotationPresentationGroups();
		const oldStore = new AnnotationStore();
		oldStore.add(selection, "old note");
		groups.projectUser(serializeEnvelope(oldStore.get(), "old request"));
		const oldAssistant = groups.projectAssistant(':pi-annotation{index="1"}', (_annotation, _index, url) => url);
		const oldUrl = oldAssistant.match(/pi-annotation:\/\/[^\s]+/)?.[0];
		const newStore = new AnnotationStore();
		newStore.add({ ...selection, text: "new text" }, "new note");
		groups.projectUser(serializeEnvelope(newStore.get(), "new request"));
		expect(oldUrl).toBeDefined();
		expect(groups.resolve(oldUrl!)?.annotation).toEqual({ text: "old text", annotation: "old note" });
	});

	test("ordinary user turns do not clear the active annotation envelope", () => {
		const selection: AnnotationSelection = {
			messageId: "m",
			messageIdStability: "stable",
			text: "selected",
			shape: "character",
			start: { row: 0, col: 0 },
			end: { row: 0, col: 1 },
			screenStart: { row: 0, col: 0 },
			screenEnd: { row: 0, col: 1 },
		};
		const store = new AnnotationStore();
		store.add(selection, "note");
		const groups = new AnnotationPresentationGroups();
		groups.projectUser(serializeEnvelope(store.get(), "request"));
		groups.projectUser("ordinary follow-up");
		const assistant = groups.projectAssistant(':pi-annotation{index="1"}', (_annotation, _index, url) => url);
		expect(groups.resolve(assistant)?.annotation).toEqual({ text: "selected", annotation: "note" });
	});

	test("projects references in the user request with user-surface identity", () => {
		const selection: AnnotationSelection = {
			messageId: "m",
			messageIdStability: "stable",
			text: "selected",
			shape: "character",
			start: { row: 0, col: 0 },
			end: { row: 0, col: 1 },
			screenStart: { row: 0, col: 0 },
			screenEnd: { row: 0, col: 1 },
		};
		const store = new AnnotationStore();
		store.add(selection, "note");
		const groups = new AnnotationPresentationGroups();
		const projected = groups.projectUser(
			serializeEnvelope(store.get(), 'mention :pi-annotation{index="1"}'),
			undefined,
			(_annotation, _index, url) => url,
		);
		const url = projected.match(/pi-annotation:\/\/[^\s]+/)?.[0];
		expect(url).toEndWith("?surface=user");
		expect(groups.resolve(url!)?.surface).toBe("user");
	});

	test("rebuilds directive lookup after a tree edit trims an empty request", () => {
		const selection: AnnotationSelection = {
			messageId: "m",
			messageIdStability: "stable",
			text: "old selection",
			shape: "character",
			start: { row: 0, col: 0 },
			end: { row: 0, col: 1 },
			screenStart: { row: 0, col: 0 },
			screenEnd: { row: 0, col: 1 },
		};
		const store = new AnnotationStore();
		store.add(selection, "old note");
		const groups = new AnnotationPresentationGroups();
		const user = groups.projectUser(serializeEnvelope(store.get(), "").trimEnd());
		const assistant = groups.projectAssistant(':pi-annotation{index="1"}', (_annotation, _index, url) => url);
		expect(user).toContain("Selected text: “old selection”");
		expect(assistant).toStartWith("pi-annotation://show/");
		expect(groups.resolve(assistant)?.annotation).toEqual({ text: "old selection", annotation: "old note" });
	});
});
