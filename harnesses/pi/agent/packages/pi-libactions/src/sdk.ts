export {
	ensureActionsRegistry,
	registerAction,
	ACTIONS_PROTOCOL,
	ACTIONS_REGISTRY_KEY,
	type ActionRegistration,
	type ActionsRegistry,
} from "./protocol/actions.ts";
export { isActionKeyId, loadActionKeybindings, type ActionKeybindings } from "./keybindings.ts";
