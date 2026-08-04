interface SelectController {
	readonly selectedId: string | undefined;
	readonly version: number;
	move(delta: number): void;
	select(id: string): void;
	setItems(ids: string[]): void;
}

export function createSelectController(ids: string[], options: { selectedId?: string } = {}): SelectController {
	return new SelectControllerImpl(ids, options.selectedId);
}

class SelectControllerImpl implements SelectController {
	private ids: string[];
	private selected: string | undefined;
	private currentVersion = 0;

	constructor(ids: string[], selectedId: string | undefined) {
		this.ids = [...ids];
		this.selected = selectedId && ids.includes(selectedId) ? selectedId : ids[0];
	}

	get selectedId(): string | undefined {
		return this.selected;
	}

	get version(): number {
		return this.currentVersion;
	}

	move(delta: number): void {
		if (this.ids.length === 0) return;
		const current = Math.max(0, this.ids.indexOf(this.selected ?? this.ids[0]!));
		const next = Math.max(0, Math.min(this.ids.length - 1, current + delta));
		this.selected = this.ids[next];
		this.currentVersion++;
	}

	select(id: string): void {
		if (!this.ids.includes(id)) return;
		this.selected = id;
		this.currentVersion++;
	}

	setItems(ids: string[]): void {
		this.ids = [...ids];
		if (!this.selected || !this.ids.includes(this.selected)) {
			this.selected = this.ids[0];
		}
		this.currentVersion++;
	}
}
