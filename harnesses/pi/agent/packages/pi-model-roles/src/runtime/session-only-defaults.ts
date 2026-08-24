import { SettingsManager } from "@earendil-works/pi-coding-agent";

const PATCH_KEY = Symbol.for("pi-model-roles/session-only-model-defaults/v1");
const PATCH_PROTOCOL = "pi-model-roles/session-only-model-defaults/v1" as const;

interface ModelDefaultMethods {
	setDefaultProvider: SettingsManager["setDefaultProvider"];
	setDefaultModel: SettingsManager["setDefaultModel"];
	setDefaultModelAndProvider: SettingsManager["setDefaultModelAndProvider"];
	setDefaultThinkingLevel: SettingsManager["setDefaultThinkingLevel"];
}

interface PatchState {
	protocol: typeof PATCH_PROTOCOL;
	version: 1;
	leases: number;
	originals: ModelDefaultMethods;
	replacements: ModelDefaultMethods;
}

// type-boundary: Symbol.for state can come from another extension generation; isPatchState validates it.
type UntrustedPatchState = unknown;

function isMethodSet(value: UntrustedPatchState): value is ModelDefaultMethods {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ModelDefaultMethods>;
	return (
		typeof candidate.setDefaultProvider === "function" &&
		typeof candidate.setDefaultModel === "function" &&
		typeof candidate.setDefaultModelAndProvider === "function" &&
		typeof candidate.setDefaultThinkingLevel === "function"
	);
}

function isPatchState(value: UntrustedPatchState): value is PatchState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PatchState>;
	return (
		candidate.protocol === PATCH_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.leases === "number" &&
		isMethodSet(candidate.originals) &&
		isMethodSet(candidate.replacements)
	);
}

function installPatch(): PatchState {
	const prototype = SettingsManager.prototype;
	const originals: ModelDefaultMethods = {
		setDefaultProvider: prototype.setDefaultProvider,
		setDefaultModel: prototype.setDefaultModel,
		setDefaultModelAndProvider: prototype.setDefaultModelAndProvider,
		setDefaultThinkingLevel: prototype.setDefaultThinkingLevel,
	};
	const replacements: ModelDefaultMethods = {
		setDefaultProvider(_provider): void {},
		setDefaultModel(_modelId): void {},
		setDefaultModelAndProvider(_provider, _modelId): void {},
		setDefaultThinkingLevel(_level): void {},
	};
	prototype.setDefaultProvider = replacements.setDefaultProvider;
	prototype.setDefaultModel = replacements.setDefaultModel;
	prototype.setDefaultModelAndProvider = replacements.setDefaultModelAndProvider;
	prototype.setDefaultThinkingLevel = replacements.setDefaultThinkingLevel;
	return { protocol: PATCH_PROTOCOL, version: 1, leases: 0, originals, replacements };
}

/**
 * Pi has no public session-only model setter. Keep its normal session events,
 * but stop model and thinking selections from rewriting the global defaults.
 * Delete this shim when Pi adds a per-call persistence option.
 */
export function installSessionOnlyModelDefaults(): () => void {
	const slots = globalThis as Record<PropertyKey, UntrustedPatchState>;
	const existing = slots[PATCH_KEY];
	const state = isPatchState(existing) ? existing : installPatch();
	if (state !== existing) slots[PATCH_KEY] = state;
	state.leases += 1;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.leases -= 1;
		if (state.leases > 0) return;

		const prototype = SettingsManager.prototype;
		if (prototype.setDefaultProvider === state.replacements.setDefaultProvider) {
			prototype.setDefaultProvider = state.originals.setDefaultProvider;
		}
		if (prototype.setDefaultModel === state.replacements.setDefaultModel) {
			prototype.setDefaultModel = state.originals.setDefaultModel;
		}
		if (prototype.setDefaultModelAndProvider === state.replacements.setDefaultModelAndProvider) {
			prototype.setDefaultModelAndProvider = state.originals.setDefaultModelAndProvider;
		}
		if (prototype.setDefaultThinkingLevel === state.replacements.setDefaultThinkingLevel) {
			prototype.setDefaultThinkingLevel = state.originals.setDefaultThinkingLevel;
		}
		if (slots[PATCH_KEY] === state) Reflect.deleteProperty(slots, PATCH_KEY);
	};
}
