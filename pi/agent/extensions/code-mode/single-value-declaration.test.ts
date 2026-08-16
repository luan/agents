import { expect, it } from "bun:test";
import { renderParameterList } from "./tool-declarations.ts";

// A single-member object buys nothing and is why a model could pass `offset`/`limit` to `read` at all. A non-object
// schema used to fall through to `Record<string, unknown>` at tool-declarations.ts:53,59 — neither a string nor an error.
it("declares a single-value tool as a named string rather than an argument bag", () => {
	expect(renderParameterList({ type: "string", title: "path", description: "File path." })).toBe("path: string");
	expect(renderParameterList({ type: "string" })).toBe("input: string");
	expect(renderParameterList({ type: "number", title: "cell_id" })).toBe("cell_id: number");
});

// Today exactly `read` (`path`) and `edit` (`input`); a tool with a second property keeps `args`.
it("declares a single-required-property object as that property", () => {
	expect(renderParameterList({ type: "object", properties: { path: { type: "string" } }, required: ["path"] })).toBe(
		"path: string",
	);
});

it("keeps args for anything a single member cannot name", () => {
	// Two properties: the object is the honest shape.
	expect(
		renderParameterList({
			type: "object",
			properties: { cmd: { type: "string" }, workdir: { type: "string" } },
			required: ["cmd"],
		}),
	).toBe("args: {\n\tcmd: string;\n\tworkdir?: string;\n}");
	// One property that is optional: a bare value would misdeclare it as required.
	expect(renderParameterList({ type: "object", properties: { skip: { type: "number" } } })).toBe(
		"args: {\n\tskip?: number;\n}",
	);
	// No properties is the one shape that cannot be named at all.
	expect(renderParameterList({ type: "object" })).toBe("args: Record<string, unknown>");
});
