import { describe, expect, test } from "bun:test";
import { AnnotationStore, removeTokenAtom, tokenInsertion, tokenPreview } from "../src/core/store.ts";
import { icon } from "pi-libtui";
import { plainPill } from "../src/core/pills.ts";
import type { AnnotationSelection } from "../src/core/types.ts";

const selection: AnnotationSelection = {
	messageId: "message-1",
	messageIdStability: "stable",
	text: "selected",
	shape: "character",
	start: { row: 1, col: 2 },
	end: { row: 1, col: 10 },
	screenStart: { row: 3, col: 2 },
	screenEnd: { row: 3, col: 10 },
};

describe("AnnotationStore", () => {
	test("assigns one private-use grapheme and global display order", () => {
		const store = new AnnotationStore();
		const first = store.add(selection, "first");
		const second = store.add(selection, "🔍 Verify");
		expect([...first.token]).toHaveLength(1);
		expect(first.token.codePointAt(0)).toBeGreaterThanOrEqual(0xe000);
		expect(second.index).toBe(2);
		expect(second.content).toBe("🔍 Verify");
	});

	test("deleting a token removes its draft and renumbers the remaining annotations", () => {
		const store = new AnnotationStore();
		const reaction1 = store.add(selection, "one");
		const comment = store.add(selection, "middle");
		const reaction2 = store.add(selection, "two");
		store.retainTokens(`${comment.token}${reaction2.token}`);
		expect(store.get().map((draft) => draft.index)).toEqual([1, 2]);
		expect(store.get()[1]?.content).toBe("two");
		expect(store.get().some((draft) => draft.id === reaction1.id)).toBe(false);
	});

	test("ordinaryText removes only owned atoms", () => {
		const store = new AnnotationStore();
		const draft = store.add(selection, "note");
		expect(store.ordinaryText(`hello ${draft.token} world`)).toBe("hello  world");
	});

	test("composer previews use the compact exact atom syntax", () => {
		const store = new AnnotationStore();
		const draft = store.add(selection, "one\ntwo\nthree");
		expect(tokenPreview(draft)).toBe(plainPill({ icon: { glyph: icon("comment") }, label: "#1" }));
		expect(tokenPreview(store.add(selection, "👍 yes"))).toBe(plainPill({ icon: { glyph: "👍" }, label: "#2" }));
	});

	test("updates annotations without preserving creation-mode metadata", () => {
		const store = new AnnotationStore();
		const first = store.add(selection, "first");
		store.add(selection, "one");
		expect(store.update(first.id, "changed")?.content).toBe("changed");
		expect(store.get()[1]?.content).toBe("one");
	});

	test("inserts inline and removes only the atom while preserving surrounding text", () => {
		expect(tokenInsertion("\ue000")).toBe("\ue000");
		expect(removeTokenAtom("before\ue000after", "\ue000")).toBe("beforeafter");
		expect(removeTokenAtom("before \ue000 after", "\ue000")).toBe("before  after");
	});
});
