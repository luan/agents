import { type Static, type TSchema, Type } from "typebox";
import { Parser, Value } from "typebox/value";

const StrictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export function createPiToolSpecs() {
	return {
		search: {
			description:
				"Search output captured from exec_command and eval. Use artifactId for deterministic retrieval from a specific capture.",
			inputSchema: StrictObject({
				query: Type.Optional(Type.String({ description: "One search query." })),
				queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries." })),
				artifactId: Type.Optional(
					Type.String({ minLength: 1, description: "Restrict retrieval to one artifact." }),
				),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
				offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
				source: Type.Optional(Type.String({ description: "Filter by project path, label, or capture metadata." })),
				sort: Type.Optional(
					Type.Union([Type.Literal("relevance"), Type.Literal("timeline")], { default: "relevance" }),
				),
			}),
		},
		status: {
			description: "Return Context Guard capture, retrieval, retention, latency, and storage status.",
			inputSchema: StrictObject({}),
		},
		purge: {
			description:
				"DESTRUCTIVE. Requires confirm: true and exactly one explicit scope: {scope:'session', sessionId} or {scope:'project'}.",
			inputSchema: Type.Union([
				StrictObject({
					confirm: Type.Literal(true),
					scope: Type.Literal("session"),
					sessionId: Type.String({ minLength: 1 }),
				}),
				StrictObject({
					confirm: Type.Literal(true),
					scope: Type.Literal("project"),
				}),
			]),
		},
	};
}

export function parseToolParams<Schema extends TSchema>(schema: Schema, params: unknown): Static<Schema> {
	const raw = (params ?? {}) as Record<string, unknown>;
	if (!Value.Check(schema, raw)) throw new Error("Invalid Context Guard tool parameters");
	return Parser(schema, raw) as Static<Schema>;
}
