import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NOTE_ENTRY, readNotes, resolveNotePath, sessionIdentity } from "../../core/state.ts";
import { resolveSession } from "../../runtime/sessions.ts";
import { registerContextTool } from "../register.ts";
import { contextResult } from "../result.ts";

const path = Type.String({ minLength: 1, maxLength: 1024 });
const optionalPrefix = Type.Optional(Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]));
export function registerNotesTools(pi: ExtensionAPI): (() => void)[] {
	const writes = ["write_file", "append_to_file"].map((operation) =>
		registerContextTool(
			pi,
			`notes__${operation}`,
			`${operation === "write_file" ? "Create or replace" : "Append to"} a working note. Paths are virtual: relative paths belong to this agent; absolute paths use /root/.../notes/<file>. Each file is limited to 1,000,000 UTF-8 bytes.`,
			Type.Object({ path, text: Type.String({ maxLength: 1000000 }) }),
			async (args, ctx) => {
				const identity = sessionIdentity(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
					target = resolveNotePath(args.path, identity.agentName),
					session = await resolveSession(ctx, target.agentName),
					notes = readNotes(session.entries());
				const text = (operation === "append_to_file" ? (notes.get(target.path)?.text ?? "") : "") + args.text;
				if (Buffer.byteLength(text, "utf8") > 1000000)
					throw new Error("Note exceeds 1,000,000 UTF-8 bytes; use another file");
				session.append(NOTE_ENTRY, { version: 1, path: target.path, text });
				return contextResult(`notes__${operation}`, args, {
					path: `${target.agentName}/notes/${target.path}`,
					bytes: Buffer.byteLength(text, "utf8"),
				});
			},
		),
	);
	return [
		...writes,
		registerContextTool(
			pi,
			"notes__read_file",
			"Read a working note, optionally selecting inclusive 1-based line numbers. Negative line numbers count backward from the end.",
			Type.Object({
				path,
				start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
				stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
			}),
			async (args, ctx) => {
				const identity = sessionIdentity(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
					target = resolveNotePath(args.path, identity.agentName),
					session = await resolveSession(ctx, target.agentName),
					note = readNotes(session.entries()).get(target.path);
				if (!note) throw new Error("Note not found");
				const lines = note.text.split("\n"),
					position = (line: number | null | undefined, fallback: number) =>
						line == null ? fallback : line < 0 ? Math.max(0, lines.length + line) : Math.max(0, line - 1),
					start = position(args.start_line, 0),
					stop = position(args.stop_line, lines.length - 1) + 1;
				const selected = lines.slice(start, stop).join("\n");
				return contextResult("notes__read_file", args, {
					path: args.path,
					text: selected,
					start_line: start + 1,
					total_lines: lines.length,
				});
			},
		),
		registerContextTool(
			pi,
			"notes__list_files_by_prefix",
			"List virtual note paths by prefix. Reads and writes are immediately visible locally.",
			Type.Object({
				prefix: optionalPrefix,
				max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
				file_order_by: Type.Optional(Type.Enum(["name", "created_at", "updated_at"])),
				file_order: Type.Optional(Type.Enum(["ascending", "descending"])),
			}),
			async (args, ctx) => {
				const identity = sessionIdentity(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
					target = resolveNotePath(args.prefix ?? "", identity.agentName, true),
					session = await resolveSession(ctx, target.agentName);
				const notes = [...readNotes(session.entries()).values()].filter((note) => note.path.startsWith(target.path)),
					field =
						args.file_order_by === "created_at"
							? "createdAt"
							: args.file_order_by === "updated_at"
								? "updatedAt"
								: "path";
				notes.sort((a, b) => a[field].localeCompare(b[field]) * (args.file_order === "descending" ? -1 : 1));
				return contextResult("notes__list_files_by_prefix", args, {
					files: notes.slice(0, args.max_results ?? 50).map((note) => ({
						path: `${target.agentName}/notes/${note.path}`,
						bytes: Buffer.byteLength(note.text, "utf8"),
						created_at: note.createdAt,
						updated_at: note.updatedAt,
					})),
					has_more: notes.length > (args.max_results ?? 50),
				});
			},
		),
		registerContextTool(
			pi,
			"notes__search_contents",
			"Search working-note lines with a case-sensitive literal substring.",
			Type.Object({
				prefix: optionalPrefix,
				query: Type.String({ maxLength: 10000 }),
				max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			}),
			async (args, ctx) => {
				const identity = sessionIdentity(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
					target = resolveNotePath(args.prefix ?? "", identity.agentName, true),
					session = await resolveSession(ctx, target.agentName);
				const matches = [...readNotes(session.entries()).values()]
					.filter((note) => note.path.startsWith(target.path))
					.flatMap((note) =>
						note.text
							.split("\n")
							.flatMap((text, index) =>
								text.includes(args.query)
									? [{ path: `${target.agentName}/notes/${note.path}`, line: index + 1, text: text.slice(0, 2000) }]
									: [],
							),
					);
				return contextResult("notes__search_contents", args, {
					matches: matches.slice(0, args.max_results ?? 50),
					has_more: matches.length > (args.max_results ?? 50),
				});
			},
		),
	];
}
