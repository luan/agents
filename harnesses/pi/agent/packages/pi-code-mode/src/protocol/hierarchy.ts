export const CODE_MODE_HIERARCHY_PROTOCOL = "pi-code-mode/tool-hierarchy/v2" as const;
export const CODE_MODE_HIERARCHY = Symbol.for(CODE_MODE_HIERARCHY_PROTOCOL);

interface CodeModeHierarchy {
	readonly protocol: typeof CODE_MODE_HIERARCHY_PROTOCOL;
	readonly version: 2;
	liftedToolNames(): readonly string[];
	setLiftedToolNames(scope: symbol, names: readonly string[]): void;
}

// type-boundary: Symbol.for can contain a value from another extension realm; this validator narrows the capability.
type UntrustedHierarchyValue = unknown;

function isHierarchy(value: UntrustedHierarchyValue): value is CodeModeHierarchy {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<CodeModeHierarchy>;
	return (
		candidate.protocol === CODE_MODE_HIERARCHY_PROTOCOL &&
		candidate.version === 2 &&
		typeof candidate.liftedToolNames === "function" &&
		typeof candidate.setLiftedToolNames === "function"
	);
}

function hierarchy(scope: typeof globalThis = globalThis): CodeModeHierarchy {
	const slots = scope as Record<PropertyKey, UntrustedHierarchyValue>;
	const existing = slots[CODE_MODE_HIERARCHY];
	if (isHierarchy(existing)) return existing;
	const liftedByScope = new Map<symbol, readonly string[]>();
	const created: CodeModeHierarchy = {
		protocol: CODE_MODE_HIERARCHY_PROTOCOL,
		version: 2,
		liftedToolNames: () => [...new Set([...liftedByScope.values()].flat())],
		setLiftedToolNames: (scope, names) => {
			if (names.length === 0) liftedByScope.delete(scope);
			else liftedByScope.set(scope, [...names]);
		},
	};
	slots[CODE_MODE_HIERARCHY] = created;
	return created;
}

export function setLiftedToolNames(scope: symbol, names: readonly string[]): void {
	hierarchy().setLiftedToolNames(scope, names);
}

export function listLiftedToolNames(): readonly string[] {
	return hierarchy().liftedToolNames();
}
