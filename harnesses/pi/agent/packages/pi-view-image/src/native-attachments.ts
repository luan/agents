import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type UserContent = Exclude<UserMessage["content"], string>[number];
type ImageContent = Extract<UserContent, { type: "image" }> & { detail?: "high" };

const FILE_TAG = /<file name="([^"]+)">([\s\S]*?)<\/file>\n?/g;
const IMAGE_PATH = /\.(?:bmp|gif|jpe?g|png|webp)$/i;

export function labelNativeImageAttachments(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return message;
		const content = labelUserImages(message.content);
		if (!content) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? next : undefined;
}

function labelUserImages(content: readonly UserContent[]): UserContent[] | undefined {
	const text = content[0];
	const images = content.filter((item): item is ImageContent => item.type === "image");
	if (text?.type !== "text" || images.length === 0) return undefined;

	const tags = [...text.text.matchAll(FILE_TAG)];
	const imageTags = tags.filter((match) => IMAGE_PATH.test(match[1] ?? ""));
	if (imageTags.length !== images.length) return undefined;

	const imageTagIndexes = new Set(imageTags.map((match) => match.index));
	const rebuilt: UserContent[] = [];
	let cursor = 0;
	let imageIndex = 0;
	for (const match of tags) {
		const index = match.index ?? 0;
		pushText(rebuilt, text.text.slice(cursor, index));
		if (imageTagIndexes.has(index)) {
			const path = match[1] ?? "";
			const hint = match[2] ?? "";
			pushText(rebuilt, `<image name=[Image #${imageIndex + 1}] path="${path}">`);
			const image: ImageContent = { ...images[imageIndex]!, detail: "high" };
			rebuilt.push(image);
			pushText(rebuilt, hint);
			pushText(rebuilt, "</image>");
			imageIndex++;
		} else {
			pushText(rebuilt, match[0]);
		}
		cursor = index + match[0].length;
	}
	pushText(rebuilt, text.text.slice(cursor));

	const remaining = content.slice(1).filter((item) => item.type !== "image");
	return [...rebuilt, ...remaining];
}

function pushText(content: UserContent[], text: string): void {
	if (text) content.push({ type: "text", text });
}
