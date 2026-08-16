/**
 * The `notebook` control tool.
 *
 * This module builds the definition and validates the parameters; the integrator registers it.
 * `normalizeNotebookRequest` is the trust boundary: the schema allows all four parameters on every
 * action, so each action rejects the ones it does not own by name, rather than ignoring them. A
 * silently ignored `names` on a `prune` would be a data-loss bug.
 */

import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NotebookAction, NotebookControlRequest, NotebookControlResult } from "./lifecycle.ts";

const NOTEBOOK_ACTIONS: readonly NotebookAction[] = [
	"status",
	"list",
	"checkpoint",
	"save",
	"load",
	"pin",
	"unpin",
	"release",
	"prune",
	"restart",
	"diagnostics",
	"reset",
];

const NOTEBOOK_PARAMETERS = Type.Object(
	{
		action: Type.Union(
			NOTEBOOK_ACTIONS.map((action) => Type.Literal(action)),
			{ description: "The control action to run." },
		),
		query: Type.Optional(Type.String({ description: "Glob for status, list, and prune. Prune requires one." })),
		name: Type.Optional(Type.String({ description: "Profile name for save and load." })),
		names: Type.Optional(
			Type.Array(Type.String(), { minItems: 1, description: "Binding names for pin, unpin, and release." }),
		),
	},
	{ additionalProperties: false },
);

export type NotebookToolParameters = typeof NOTEBOOK_PARAMETERS;

const DESCRIPTION =
	"Control persistent notebook state: status inspects memory and bindings by query glob; checkpoint; pin/unpin/release names; prune unpinned matches; list/save/load profiles; restart; diagnostics; reset";

/**
 * Builds the definition. `control` is the session's `NotebookLifecycleController.control`, bound to
 * the session the extension context names.
 */
export function notebookToolDefinition(
	control: (
		request: NotebookControlRequest,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	) => Promise<NotebookControlResult>,
): ToolDefinition<NotebookToolParameters> {
	return {
		name: "notebook",
		label: "notebook",
		description: DESCRIPTION,
		promptSnippet: "Inspect, recover, or control persistent notebook state.",
		executionMode: "sequential",
		parameters: NOTEBOOK_PARAMETERS,
		async execute(
			_toolCallId: string,
			params: { action: NotebookAction; query?: string; name?: string; names?: string[] },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<Record<string, unknown>>> {
			const result = await control(normalizeNotebookRequest(params), ctx, signal);
			return { content: [{ type: "text", text: result.message }], details: result.details };
		},
	};
}

export function normalizeNotebookRequest(params: {
	action: string;
	query?: string | undefined;
	name?: string | undefined;
	names?: string[] | undefined;
}): NotebookControlRequest {
	const query = params.query ?? undefined;
	const name = params.name ?? undefined;
	const names = params.names ?? undefined;
	const action = params.action;
	if (action === "status" || action === "list") {
		if (name !== undefined || names !== undefined) throw new Error(`notebook ${action} accepts query only`);
		return { action, ...(query === undefined ? {} : { query }) };
	}
	if (action === "save" || action === "load") {
		if (query !== undefined || names !== undefined) throw new Error(`notebook ${action} accepts name only`);
		if (!name) throw new Error(`notebook ${action} requires name`);
		return { action, name };
	}
	if (action === "pin" || action === "unpin" || action === "release") {
		if (query !== undefined || name !== undefined) throw new Error(`notebook ${action} accepts names only`);
		if (!names?.length) throw new Error(`notebook ${action} requires at least one name`);
		return { action, names: [...new Set(names)] };
	}
	if (action === "prune") {
		if (name !== undefined || names !== undefined) throw new Error("notebook prune accepts query only");
		// No default glob. Prune deletes, so an absent glob is a caller error, never a match on everything.
		if (!query) throw new Error("notebook prune requires query");
		return { action, query };
	}
	if (action !== "checkpoint" && action !== "restart" && action !== "diagnostics" && action !== "reset") {
		throw new Error(`Unsupported notebook action: ${action}`);
	}
	if (query !== undefined || name !== undefined || names !== undefined) {
		throw new Error(`notebook ${action} accepts only action`);
	}
	return { action };
}
