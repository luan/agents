export const CHECKPOINT_SCHEMA = 1;

export interface CheckpointEntry {
	name: string;
	kind: "value" | "function";
	offset: number;
	length: number;
}

/**
 * A session checkpoint is a delta against one project generation.
 * `projectGeneration` and `projectNames` record which generation the delta was taken against, so a
 * stale session cannot overwrite a newer project state on restore.
 */
export interface CheckpointManifest {
	schema: number;
	project: string;
	projectGeneration?: string | undefined;
	projectNames?: string[] | undefined;
	session: string;
	deno: string;
	v8: string;
	payload: string;
	createdAt: string;
	entries: CheckpointEntry[];
	skipped: Array<{ name: string; reason: string }>;
}

export interface NotebookCheckpointIdentity {
	project: string;
	session: string;
	agentDir: string;
}
