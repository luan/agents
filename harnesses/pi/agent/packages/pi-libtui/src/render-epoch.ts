const RENDER_EPOCH_KEY = Symbol.for("pi-libtui/render-epoch/v1");
const RENDER_EPOCH_TAG = "pi-libtui/render-epoch/v1" as const;

// type-boundary: Symbol.for state may come from another installed libtui realm; validate it before use.
type UntrustedRenderEpochValue = unknown;

interface RenderEpochRegistry {
	readonly tag: typeof RENDER_EPOCH_TAG;
	readonly current: () => number;
	readonly bump: () => void;
}

function isRenderEpochRegistry(value: UntrustedRenderEpochValue): value is RenderEpochRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RenderEpochRegistry>;
	return (
		candidate.tag === RENDER_EPOCH_TAG &&
		typeof candidate.current === "function" &&
		typeof candidate.bump === "function"
	);
}

function renderEpochRegistry(scope: typeof globalThis = globalThis): RenderEpochRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRenderEpochValue>;
	const existing = slots[RENDER_EPOCH_KEY];
	if (isRenderEpochRegistry(existing)) return existing;

	let epoch = 0;
	const registry: RenderEpochRegistry = {
		tag: RENDER_EPOCH_TAG,
		current: () => epoch,
		bump: () => {
			epoch += 1;
		},
	};
	slots[RENDER_EPOCH_KEY] = registry;
	return registry;
}

/** Return the current process-wide rendering epoch. */
export function getTuiRenderEpoch(): number {
	return renderEpochRegistry().current();
}

/** Advance the rendering epoch after effective shared appearance changes. */
export function bumpTuiRenderEpoch(): void {
	renderEpochRegistry().bump();
}
