import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModelRoleCatalog, registerModelRoleSettings } from "./config/settings.ts";
import { isModelRoleName, roleNames } from "./core/catalog.ts";
import { registerModelRoleActions } from "./contributions/actions.ts";
import { registerRoleContextWindowSource } from "./contributions/context-window.ts";
import { ModelRolesRuntime } from "./runtime/roles.ts";
import { MODEL_ROLE_SELECTION_ENTRY } from "./runtime/selection.ts";
import { installSessionOnlyModelDefaults } from "./runtime/session-only-defaults.ts";
import { openRolePicker } from "./ui/role-picker.ts";

export default function modelRolesExtension(pi: ExtensionAPI): void {
	const restoreDefaultPersistence = installSessionOnlyModelDefaults();
	const runtime = new ModelRolesRuntime(
		{
			setModel: (model) => pi.setModel(model),
			setThinkingLevel: (level) => pi.setThinkingLevel(level),
			appendSelection: (role) => pi.appendEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 1, role }),
		},
		getModelRoleCatalog,
	);
	let currentContext: ExtensionContext | undefined;
	const unregisterSettings = registerModelRoleSettings(async () => {
		if (currentContext) await runtime.restore(currentContext);
	});
	const unregisterContextWindowSource = registerRoleContextWindowSource(
		() => currentContext?.sessionManager,
		() => runtime.activeContextWindow(),
	);
	const restoreSession = async (_event: object, ctx: ExtensionContext): Promise<void> => {
		currentContext = ctx;
		await runtime.restore(ctx);
	};
	async function chooseRole(ctx: ExtensionContext): Promise<void> {
		const catalog = getModelRoleCatalog();
		const selected = await openRolePicker(ctx, runtime.currentRole() ?? catalog.defaultRole, catalog);
		if (selected) await runtime.select(selected, ctx);
	}
	const unregisterActions = registerModelRoleActions({ select: chooseRole });

	pi.on("session_start", restoreSession);
	pi.on("session_tree", restoreSession);
	pi.on("model_select", (event, ctx) => runtime.modelSelected(event.model.provider, event.model.id, ctx));
	pi.on("thinking_level_select", (event, ctx) => runtime.thinkingSelected(event.level, ctx));
	pi.on("session_shutdown", (event, ctx) => {
		runtime.dispose(ctx);
		if (currentContext?.sessionManager === ctx.sessionManager) currentContext = undefined;
		if (event.reason !== "reload" && event.reason !== "quit") return;
		unregisterActions();
		unregisterContextWindowSource();
		unregisterSettings();
		restoreDefaultPersistence();
	});

	pi.registerCommand("role", {
		description: "Select a model role for this session",
		getArgumentCompletions(prefix) {
			const values = ["clear", ...roleNames(getModelRoleCatalog())];
			const token = prefix.trim();
			const matches = values.filter((value) => value.startsWith(token)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const argument = args.trim();
			if (!argument) {
				await chooseRole(ctx);
				return;
			}
			if (argument === "clear") {
				await runtime.clear(ctx);
				return;
			}
			const catalog = getModelRoleCatalog();
			if (!isModelRoleName(catalog, argument)) {
				ctx.ui.notify(`Usage: /role [clear|${roleNames(catalog).join("|")}]`, "warning");
				return;
			}
			await runtime.select(argument, ctx);
		},
	});
}
