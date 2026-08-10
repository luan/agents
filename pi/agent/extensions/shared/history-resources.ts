import { readFile } from "node:fs/promises";
import {
	formatResourceUri,
	type Resource,
	type ResourceContext,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
} from "./resources.ts";

type SessionMessage = {
	id: string;
	role: string;
	text: string;
	timestamp?: string;
};

function sessionFile(context: ResourceContext | undefined): string {
	if (!context?.sessionFile) throw new Error("History resource needs an active session file");
	return context.sessionFile;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n")
		.trim();
}

async function sessionMessages(context: ResourceContext | undefined): Promise<SessionMessage[]> {
	const path = sessionFile(context);
	const lines = (await readFile(path, "utf8")).split(/\r?\n/);
	const messages: SessionMessage[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: { id?: unknown; type?: unknown; timestamp?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown };
		const text = textFromContent(message.content);
		if (!text || typeof message.role !== "string") continue;
		messages.push({
			id: typeof entry.id === "string" ? entry.id : `message-${messages.length + 1}`,
			role: message.role,
			text,
			timestamp:
				typeof message.timestamp === "string"
					? message.timestamp
					: typeof entry.timestamp === "string"
						? entry.timestamp
						: undefined,
		});
	}
	return messages;
}

function messagePath(ref: ResourceRef): string | undefined {
	const path = ref.path.replace(/^\/+/, "");
	return path || undefined;
}

function messageUri(id: string): string {
	return formatResourceUri({ scheme: "history", authority: "current", path: `/${id}`, query: {} });
}

function messageResource(uri: string, message: SessionMessage): Resource {
	return {
		uri,
		name: message.id,
		title: message.role,
		kind: "history-message",
		mediaType: "text/plain",
		size: Buffer.byteLength(message.text, "utf8"),
		metadata: { role: message.role, text: message.text, timestamp: message.timestamp },
	};
}

export function historyResourceProvider(): ResourceProvider {
	return {
		async read(ref, context) {
			if (ref.authority !== "current") throw new Error(`Unknown history session: ${ref.authority}`);
			const messages = await sessionMessages(context);
			const selected = messagePath(ref) ? messages.filter((message) => message.id === messagePath(ref)) : messages;
			if (messagePath(ref) && selected.length === 0)
				throw new Error(`History message not found: ${formatResourceUri(ref)}`);
			const content = selected.map((message) => `[${message.role}] ${message.text}`).join("\n\n");
			return {
				resource:
					messagePath(ref) && selected[0]
						? messageResource(formatResourceUri(ref), selected[0])
						: {
								uri: formatResourceUri(ref),
								name: "current session",
								kind: "history-session",
								mediaType: "text/plain",
								size: Buffer.byteLength(content, "utf8"),
							},
				content,
			};
		},
		async search(request): Promise<SearchHit[]> {
			if (request.scope?.scheme !== "history") return [];
			if (request.scope.authority !== "current")
				throw new Error(`Unknown history session: ${request.scope.authority}`);
			const query = request.query.trim().toLowerCase();
			if (!query) return [];
			const messages = await sessionMessages(request.context);
			return messages
				.filter((message) => message.text.toLowerCase().includes(query))
				.slice(0, request.limit ?? 50)
				.map((message) => ({
					...messageResource(messageUri(message.id), message),
					snippet: message.text,
					score: 1,
				}));
		},
		async find(ref, context) {
			if (ref.authority !== "current") throw new Error(`Unknown history session: ${ref.authority}`);
			const messages = await sessionMessages(context);
			if (messagePath(ref)) {
				const message = messages.find((item) => item.id === messagePath(ref));
				return message ? [messageResource(messageUri(message.id), message)] : [];
			}
			return messages.map((message) => messageResource(messageUri(message.id), message));
		},
	};
}
