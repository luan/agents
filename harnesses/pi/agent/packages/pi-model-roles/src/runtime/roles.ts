import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { tuiTheme } from "pi-libtui";
import { roleColor } from "../config/role-colors.ts";
import {
	availableModels,
	isModelRoleName,
	modelKey,
	resolveModelRole,
	type ModelRoleCatalog,
	type ModelRoleName,
	withServiceTier,
	type ResolvedModelRole,
} from "../core/catalog.ts";
import { latestRoleSelection } from "./selection.ts";

export interface ModelRolesHost {
	setModel(model: Model<Api>): Promise<boolean>;
	setThinkingLevel(level: ThinkingLevel): void;
	appendSelection(role: string | null): void;
}

export interface ModelRolesContext {
	model: ExtensionContext["model"];
	scopedModels: ExtensionContext["scopedModels"];
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable">;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
	hasUI: boolean;
	ui: Pick<ExtensionContext["ui"], "notify" | "setStatus"> & {
		theme: ExtensionContext["ui"]["theme"];
	};
}

export class ModelRolesRuntime {
	private active: ResolvedModelRole | undefined;
	private pending: ResolvedModelRole | undefined;

	constructor(
		private readonly host: ModelRolesHost,
		private readonly getCatalog: () => ModelRoleCatalog,
	) {}

	currentRole(): ModelRoleName | undefined {
		if (!this.active) return undefined;
		return isModelRoleName(this.getCatalog(), this.active.requestedRole)
			? this.active.requestedRole
			: this.active.role.name;
	}

	activeContextWindow(): "smart" | "balanced" | "enhanced" | "large" | "max" | undefined {
		const candidate = this.active?.candidate;
		const preference = candidate && "contextWindow" in candidate ? candidate.contextWindow : undefined;
		return preference && preference !== "default" ? preference : undefined;
	}

	async restore(ctx: ModelRolesContext): Promise<void> {
		const saved = latestRoleSelection(ctx.sessionManager.getBranch());
		const requested = typeof saved === "string" ? saved : this.getCatalog().defaultRole;
		await this.apply(requested, ctx, false, false);
	}

	async select(role: string, ctx: ModelRolesContext): Promise<void> {
		if (!isModelRoleName(this.getCatalog(), role)) {
			ctx.ui.notify(`Unknown model role "${role}".`, "error");
			return;
		}
		await this.apply(role, ctx, true, true);
	}

	async clear(ctx: ModelRolesContext): Promise<void> {
		this.host.appendSelection(null);
		await this.apply(this.getCatalog().defaultRole, ctx, false, true);
	}

	modelSelected(provider: string, id: string, ctx: ModelRolesContext): void {
		const expected = this.pending ?? this.active;
		if (!expected || modelKey(expected.model) === `${provider}/${id}`) return;
		this.clearActive(ctx);
	}

	thinkingSelected(level: ThinkingLevel, ctx: ModelRolesContext): void {
		const expected = this.pending ?? this.active;
		if (!expected || expected.candidate.thinking === level) return;
		this.clearActive(ctx);
	}

	dispose(ctx?: ModelRolesContext): void {
		if (ctx) ctx.ui.setStatus("model-roles.current", undefined);
		this.active = undefined;
		this.pending = undefined;
	}

	private async apply(requestedRole: string, ctx: ModelRolesContext, persist: boolean, notify: boolean): Promise<void> {
		const resolved = resolveModelRole(
			requestedRole,
			this.getCatalog(),
			availableModels(ctx.modelRegistry, ctx.scopedModels),
		);
		if (!resolved) {
			this.clearActive(ctx);
			ctx.ui.notify(`No usable model candidate for role "${requestedRole}".`, "error");
			return;
		}

		this.pending = resolved;
		try {
			const selectedModel = withServiceTier(resolved.model, resolved.candidate.serviceTier);
			const currentServiceTier = ctx.model && "serviceTier" in ctx.model ? ctx.model.serviceTier : undefined;
			if (
				!ctx.model ||
				modelKey(ctx.model) !== modelKey(selectedModel) ||
				currentServiceTier !== selectedModel.serviceTier
			) {
				if (!(await this.host.setModel(selectedModel))) {
					ctx.ui.notify(`No credentials for ${resolved.candidate.model}.`, "error");
					return;
				}
			}
			this.host.setThinkingLevel(resolved.candidate.thinking);
			this.active = resolved;
			if (persist) {
				this.host.appendSelection(requestedRole);
			}
			this.updateStatus(ctx);
			if (notify) ctx.ui.notify(`Role: ${this.roleLabel(this.active)}`, "info");
		} catch (error) {
			this.clearActive(ctx);
			ctx.ui.notify(
				`Failed to select role "${requestedRole}": ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			this.pending = undefined;
		}
	}

	private roleLabel(active: ResolvedModelRole): string {
		return active.requestedRole === active.role.name
			? active.requestedRole
			: `${active.requestedRole} (fallback: ${active.role.name})`;
	}

	private updateStatus(ctx: ModelRolesContext): void {
		if (!ctx.hasUI || !this.active) return;
		const colors = tuiTheme(ctx.ui.theme);
		ctx.ui.setStatus("model-roles.current", colors.fg(roleColor(this.active.role.color), this.roleLabel(this.active)));
	}

	private clearActive(ctx: ModelRolesContext): void {
		this.active = undefined;
		ctx.ui.setStatus("model-roles.current", undefined);
	}
}
