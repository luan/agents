type Schema = Record<string, unknown>;

const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;

export const COMMAND_DETAILS_SCHEMA: Schema = {
	title: "CommandDetails",
	type: "object",
	properties: {
		exit_code: number,
		wall_time_seconds: number,
		process_id: number,
		stdin_open: boolean,
		terminal_state: { enum: ["exited", "cancelled", "session_error"] },
		output_truncated: boolean,
		original_token_count: number,
		until_matched: boolean,
	},
	required: ["wall_time_seconds"],
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function projectFields(details: unknown, fields: readonly string[]): unknown {
	const source = record(details);
	if (!source) return undefined;
	const projected: Record<string, unknown> = {};
	for (const field of fields) if (source[field] !== undefined) projected[field] = source[field];
	return Object.keys(projected).length > 0 ? projected : undefined;
}

const COMMAND_FIELDS = [
	"exit_code",
	"wall_time_seconds",
	"process_id",
	"stdin_open",
	"terminal_state",
	"output_truncated",
	"original_token_count",
	"until_matched",
] as const;

export function projectCommandDetails(details: unknown): unknown {
	return projectFields(details, COMMAND_FIELDS);
}
