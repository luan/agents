import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "pi-libactions/sdk";

export function registerModelRoleActions(actions: { select(ctx: ExtensionContext): void | Promise<void> }): () => void {
	return registerAction({ id: "model-roles.select", description: "Select model role", run: actions.select });
}
