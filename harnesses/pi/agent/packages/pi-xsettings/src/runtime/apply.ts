import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return "reload" in ctx && typeof (ctx as Partial<ExtensionCommandContext>).reload === "function";
}

export async function applySavedSettings(
	ctx: ExtensionContext,
	changed: boolean,
	reloadRequired = changed,
): Promise<void> {
	if (!changed || !reloadRequired) return;
	if (isCommandContext(ctx)) {
		await ctx.reload();
		return;
	}
	ctx.ui.notify("Settings were saved. Run /reload to apply them to this session.", "info");
}

export function applyLiveTheme(ctx: ExtensionContext, themeName: string): boolean {
	const result = ctx.ui.setTheme(themeName);
	if (result.success) return true;
	ctx.ui.notify(`Could not apply theme "${themeName}": ${result.error ?? "unknown theme"}`, "error");
	return false;
}
