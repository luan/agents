import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_IMAGE_PILL_IDENTITY } from "./appearance.ts";

const IMAGE_PATH = /\.(?:gif|jpe?g|png|webp)$/i;
// Annotations own the BMP private-use area. Image atoms use the supplementary
// private-use plane so independently installed editor features cannot collide.
const FIRST_IMAGE_TOKEN = 0xf0000;
const LAST_IMAGE_TOKEN = 0xffffd;

export interface PendingImageAttachment {
	token: string;
	label: string;
	path: string;
}

export class ImageAttachmentStore {
	private readonly attachments = new Map<string, PendingImageAttachment>();
	private nextToken = FIRST_IMAGE_TOKEN;

	add(path: string): string {
		if (this.nextToken > LAST_IMAGE_TOKEN) throw new Error("Too many pending image attachments");
		const token = String.fromCodePoint(this.nextToken++);
		this.attachments.set(token, { token, label: "", path });
		return token;
	}

	inText(text: string): PendingImageAttachment[] {
		return this.occurrences(text).map(({ attachment }, index) => ({ ...attachment, label: `[Image #${index + 1}]` }));
	}

	presentations(text: string): Array<{
		token: string;
		label: string;
		icon: "view-image";
		iconTone: { hue: "magenta"; shade: 2 };
	}> {
		const seen = new Set<string>();
		return this.inText(text).flatMap((attachment) => {
			if (seen.has(attachment.token)) return [];
			seen.add(attachment.token);
			return [
				{
					token: attachment.token,
					label: attachment.label.slice(1, -1),
					...VIEW_IMAGE_PILL_IDENTITY,
				},
			];
		});
	}

	clear(): void {
		this.attachments.clear();
		this.nextToken = FIRST_IMAGE_TOKEN;
	}

	private occurrences(text: string): Array<{ index: number; attachment: PendingImageAttachment }> {
		const found: Array<{ index: number; attachment: PendingImageAttachment }> = [];
		for (const attachment of this.attachments.values()) {
			let index = text.indexOf(attachment.token);
			while (index >= 0) {
				found.push({ index, attachment });
				index = text.indexOf(attachment.token, index + attachment.token.length);
			}
		}
		return found.sort((left, right) => left.index - right.index);
	}
}

export function pastedImagePath(text: string, cwd: string): string | undefined {
	const normalized = normalizePastedPath(text, cwd);
	if (!normalized || !IMAGE_PATH.test(normalized)) return undefined;
	try {
		return existsSync(normalized) && statSync(normalized).isFile() && hasSupportedImageSignature(normalized)
			? normalized
			: undefined;
	} catch {
		return undefined;
	}
}

function hasSupportedImageSignature(path: string): boolean {
	const handle = openSync(path, "r");
	try {
		const header = Buffer.alloc(12);
		const bytes = readSync(handle, header, 0, header.length, 0);
		if (bytes >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
		if (bytes >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
		if (
			bytes >= 6 &&
			(header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")
		)
			return true;
		return (
			bytes >= 12 &&
			header.subarray(0, 4).toString("ascii") === "RIFF" &&
			header.subarray(8, 12).toString("ascii") === "WEBP"
		);
	} finally {
		closeSync(handle);
	}
}

function normalizePastedPath(text: string, cwd: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
	const unquoted = stripMatchingQuotes(trimmed);
	if (unquoted.startsWith("file://")) {
		try {
			return fileURLToPath(unquoted);
		} catch {
			return undefined;
		}
	}
	const shellUnescaped = unquoted.replace(/\\([\\ "'])/g, "$1");
	const expanded =
		shellUnescaped === "~"
			? homedir()
			: shellUnescaped.startsWith("~/")
				? resolve(homedir(), shellUnescaped.slice(2))
				: shellUnescaped;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function stripMatchingQuotes(text: string): string {
	if (text.length < 2) return text;
	const first = text[0];
	return (first === '"' || first === "'") && text.at(-1) === first ? text.slice(1, -1) : text;
}

export function replaceAttachmentToken(text: string, attachment: PendingImageAttachment, replacement: string): string {
	const index = text.indexOf(attachment.token);
	return index < 0 ? text : `${text.slice(0, index)}${replacement}${text.slice(index + attachment.token.length)}`;
}

export function attachmentFileTag(path: string): string {
	const escaped = path
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return `<file name="${escaped}"></file>\n`;
}
