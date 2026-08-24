import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ActionKeybindings, type ActionRegistration, ensureActionsRegistry } from "pi-libactions/sdk";

export function attachActionShortcuts(
	pi: Pick<ExtensionAPI, "registerShortcut">,
	bindings: ActionKeybindings,
): () => void {
	// This is the global action host boundary. Feature packages publish actions
	// through pi-libactions; only this host translates configured keys to Pi's
	// shortcut API. Pi has no public API for a host-independent custom shortcut.
	const registry = ensureActionsRegistry();
	const registered = new Set<string>();
	const register = (action: ActionRegistration): void => {
		for (const key of bindings[action.id] ?? []) {
			const identity = `${action.id}\0${key}`;
			if (registered.has(identity)) continue;
			registered.add(identity);
			pi.registerShortcut(key, {
				description: action.description,
				handler: (ctx) => registry.find(action.id)?.run(ctx),
			});
		}
	};
	for (const id of Object.keys(bindings)) {
		const action = registry.find(id);
		if (action) register(action);
	}
	return registry.onRegister(register);
}
