export type ActionType = "add" | "delete" | "update";

export interface ParsedPatchAction {
	type: ActionType;
	path: string;
	newFile?: string;
	lines?: string[];
	movePath?: string;
}

export interface ExecutePatchResult {
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	movedFiles: string[];
	fuzz: number;
	diff?: string;
}

export interface ExecutePatchFailure {
	action: ParsedPatchAction;
	message: string;
}

export class ExecutePatchError extends Error {
	readonly result: ExecutePatchResult;
	readonly failures: ExecutePatchFailure[];

	constructor(message: string, result: ExecutePatchResult, failures: ExecutePatchFailure[] = []) {
		super(message);
		this.name = "ExecutePatchError";
		this.result = result;
		this.failures = failures;
	}

	hasPartialSuccess(): boolean {
		return (
			this.result.changedFiles.length > 0 ||
			this.result.createdFiles.length > 0 ||
			this.result.deletedFiles.length > 0 ||
			this.result.movedFiles.length > 0 ||
			this.result.fuzz > 0
		);
	}
}
