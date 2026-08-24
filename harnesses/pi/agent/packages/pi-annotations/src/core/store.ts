import type { AnnotationSelection, DraftAnnotation } from "./types.ts";
import { composerPillContent, plainPill } from "./pills.ts";

const TOKEN_START = 0xe000;
const TOKEN_END = 0xf8ff;

export type DraftListener = (drafts: readonly DraftAnnotation[]) => void;

export class AnnotationStore {
	private drafts: DraftAnnotation[] = [];
	private nextId = 1;
	private listeners: DraftListener[] = [];

	get(): readonly DraftAnnotation[] {
		return this.drafts;
	}

	add(selection: AnnotationSelection, content: string): DraftAnnotation {
		const ordinal = this.nextId++;
		const tokenCode = TOKEN_START + ((ordinal - 1) % (TOKEN_END - TOKEN_START + 1));
		const draft: DraftAnnotation = {
			id: `annotation-${ordinal}`,
			index: this.drafts.length + 1,
			token: String.fromCodePoint(tokenCode),
			selection,
			content,
		};
		this.drafts.push(draft);
		this.emit();
		return draft;
	}

	remove(id: string): boolean {
		const next = this.drafts.filter((draft) => draft.id !== id);
		if (next.length === this.drafts.length) return false;
		this.drafts = renumber(next);
		this.emit();
		return true;
	}

	update(id: string, content: string): DraftAnnotation | undefined {
		const index = this.drafts.findIndex((draft) => draft.id === id);
		const current = this.drafts[index];
		if (index < 0 || !current) return undefined;
		this.drafts[index] = { ...current, content };
		this.drafts = renumber(this.drafts);
		this.emit();
		return this.drafts[index];
	}

	find(id: string): DraftAnnotation | undefined {
		return this.drafts.find((draft) => draft.id === id);
	}

	retainTokens(text: string): void {
		const next = this.drafts.filter((draft) => text.includes(draft.token));
		if (next.length === this.drafts.length) return;
		this.drafts = renumber(next);
		this.emit();
	}

	clear(): void {
		if (this.drafts.length === 0) return;
		this.drafts = [];
		this.emit();
	}

	ordinaryText(text: string): string {
		let result = text;
		for (const draft of this.drafts) result = result.replaceAll(draft.token, "");
		return result.trim();
	}

	onChange(listener: DraftListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener(this.drafts);
	}
}

function renumber(drafts: readonly DraftAnnotation[]): DraftAnnotation[] {
	return drafts.map((draft, index) => ({ ...draft, index: index + 1 }));
}

export function tokenPreview(draft: DraftAnnotation): string {
	return plainPill(composerPillContent(draft));
}

export function tokenInsertion(token: string): string {
	return token;
}

export function removeTokenAtom(text: string, token: string): string {
	return text.replaceAll(token, "");
}
