/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured {@link Filesystem}, strips BOM and normalizes line endings,
 * validates the section snapshot tag (with {@link Recovery}), applies the
 * result back through the same {@link Filesystem}.
 *
 * Two layers:
 *
 * - {@link Patcher.apply} — high-level, all-or-nothing. Preflights every
 *   section in memory before any write hits disk, then commits in order.
 * - {@link Patcher.prepare} / {@link Patcher.commit} — granular primitives
 *   for callers that need per-section control (e.g. batched LSP flush,
 *   custom interleaving). `prepare` performs all the read-side work,
 *   validates the section snapshot tag (with recovery), and applies the
 *   edits in memory. `commit` writes the prepared result and records a
 *   fresh snapshot.
 *
 * Because `prepare` already runs the full apply, a multi-section batch is
 * naturally all-or-nothing: by the time any `commit` runs, every section
 * has been validated.
 *
 * The patcher itself is stateless across calls; reuse one instance per
 * filesystem configuration.
 */
import { applyEdits } from "./apply";
import { hasBlockEdit, resolveBlockEdits } from "./block";
import { commitClipboard, forkClipboard, startClipboardBatch } from "./clipboard";
import { formatHashlineHeader } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import { HEADTAIL_DRIFT_WARNING, missingSnapshotTagMessage } from "./messages";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { Recovery, type RecoveryResult } from "./recovery";
import { computeFileHash, type Snapshot, type SnapshotStore } from "./snapshots";
import type {
	ApplyOptions,
	ApplyResult,
	BlockResolution,
	BlockResolver,
	Clipboard,
	Edit,
	FileOp,
	SyntaxValidator,
} from "./types";

export type HashlineChange = {
	path: string;
	kind: "update" | "delete";
	movePath?: string;
};

export type HashlineContract = {
	status: "success" | "failure";
	error: string | null;
	exact: boolean;
	result: {
		changedFiles: string[];
		createdFiles: string[];
		deletedFiles: string[];
		movedFiles: string[];
		fuzz: number;
	};
	changes: HashlineChange[];
};

export class HashlineApplyError extends Error {
	readonly name = "HashlineApplyError";

	constructor(
		message: string,
		readonly contract: HashlineContract,
	) {
		super(message);
	}
}

interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/** Snapshot store that minted and resolves hashline section tags. Required. */
	snapshots: SnapshotStore;
	/**
	 * Resolves `PUT N*:` anchors to concrete line spans via tree-sitter.
	 * Optional: when omitted, any `PUT N*:` edit throws on apply (the host
	 * did not wire a resolver). Plain line-range ops never need it.
	 */
	blockResolver?: BlockResolver;
	/** Optional apply-time behavior knobs. */
	applyOptions?: ApplyOptions;
	/** Optional parser-backed syntax gate. When present, enabled by default. */
	syntaxValidator?: SyntaxValidator;
	/** Disable syntax validation for callers that need legacy apply-only behavior. */
	validateSyntax?: boolean;
	/** Permit edits anchored only to synthetic block-context lines. Defaults false. */
	allowSyntheticContextEdits?: boolean;
	/** Optional named-register store shared across edit calls. */
	clipboard?: Clipboard;
}

/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
	/** Section path (as authored, after cwd-resolution at parse time). */
	path: string;
	/** Filesystem-canonical key for this section (e.g. absolute path). */
	canonicalPath: string;
	/** Delete removes the file; noop leaves it unchanged. */
	op: "update" | "delete" | "noop";
	/** Pre-edit text (LF-normalized, BOM-stripped). */
	before: string;
	/** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
	after: string;
	/** Same text as `after` but with the original BOM and line ending restored. */
	persisted: string;
	/** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
	written: string;
	/** 4-hex opaque snapshot tag for `after`. Use to anchor follow-up edits. */
	fileHash: string;
	/** Hashline section header (`[path#tag]`) of the post-edit content. */
	header: string;
	/** 1-indexed first changed line in `after`, or `undefined` for noops. */
	firstChangedLine?: number;
	/** Warnings collected by the parser, applier, and (optionally) recovery. */
	warnings: string[];
	/**
	 * Resolved spans for any `PUT N*:`/`CUT N*` ops, present when the
	 * apply matched the tagged content. Undefined for patches with no block ops
	 * (and for resolutions routed through drift recovery, where numbers shift).
	 */
	blockResolutions?: BlockResolution[];
	/** Destination path when this section includes MV. */
	moveDest?: string;
	/**
	 * `"unchecked"` means no validator claimed this format, never that the edit passed. Aggregate it for coverage;
	 * it is not a warning, because `.txt` and extensionless edits are legitimately unchecked on every call.
	 */
	validation: SectionValidation;
}

type SectionValidation = "checked" | "unchecked";

interface PatcherApplyResult {
	sections: PatchSectionResult[];
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

export function hashlineContract(
	status: HashlineContract["status"],
	error: string | null,
	sections: readonly PatchSectionResult[],
): HashlineContract {
	const changedFiles: string[] = [];
	const createdFiles: string[] = [];
	const deletedFiles: string[] = [];
	const movedFiles: string[] = [];
	const changes: HashlineChange[] = [];
	for (const section of sections) {
		if (section.op === "noop") continue;
		pushUnique(changedFiles, section.path);
		if (section.op === "delete") {
			pushUnique(deletedFiles, section.path);
			changes.push({ path: section.path, kind: "delete" });
			continue;
		}
		const change: HashlineChange = {
			path: section.path,
			kind: "update",
		};
		if (section.moveDest) {
			change.movePath = section.moveDest;
			pushUnique(changedFiles, section.moveDest);
			pushUnique(deletedFiles, section.path);
			pushUnique(createdFiles, section.moveDest);
			movedFiles.push(`${section.path} -> ${section.moveDest}`);
		}
		changes.push(change);
	}
	const exact = sections.every((section) => section.warnings.length === 0);
	return {
		status,
		error,
		exact,
		result: { changedFiles, createdFiles, deletedFiles, movedFiles, fuzz: exact ? 0 : 1 },
		changes,
	};
}

/**
 * Opaque token returned by {@link Patcher.prepare}. Carries the section, the
 * raw file content read off disk, and the in-memory apply result.
 * {@link Patcher.commit} just writes the {@link PreparedSection.applyResult}.
 */
class PreparedSection {
	/** @internal */
	constructor(
		readonly section: PatchSection,
		readonly canonicalPath: string,
		readonly exists: boolean,
		readonly rawContent: string,
		readonly bom: string,
		readonly lineEnding: LineEnding,
		readonly normalized: string,
		readonly applyResult: ApplyResult,
		readonly parseWarnings: readonly string[],
		readonly fileOp: FileOp | undefined,
		readonly validation: SectionValidation,
	) {}

	/** Convenience: returns true when the apply produced no change. */
	get isNoop(): boolean {
		return this.fileOp === undefined && this.applyResult.text === this.normalized;
	}
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some((edit) => {
		if (edit.kind === "delete" || edit.kind === "block" || edit.kind === "cut") return true;
		if (edit.kind === "paste") {
			if (edit.at.kind === "span") return true;
			return edit.at.cursor.kind === "before_anchor" || edit.at.cursor.kind === "after_anchor";
		}
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): void {
	if (fileHash !== undefined) return;
	throw new Error(missingSnapshotTagMessage(sectionPath));
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}

function snapshotProvesUnchanged(snapshot: Snapshot, currentText: string): boolean {
	return snapshot.fullText === currentText;
}

/** File lines as `read` displays them: a trailing newline does not add a line. */
function splitDisplayLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

/**
 * Whether a file's brokenness is knowable at all. `unchecked` is a distinct
 * state from "zero errors": it means no validator claimed this format, so the
 * edit is unguarded. Naming it stops the old `number | null` from reading as
 * "passed" at the call site.
 */
type SyntaxCheck = { kind: "checked"; errorCount: number; detail?: string } | { kind: "unchecked" };

function syntaxCheck(result: ReturnType<SyntaxValidator>): SyntaxCheck {
	if (result.kind === "unsupported_language" || result.kind === "parser_unavailable") return { kind: "unchecked" };
	return {
		kind: "checked",
		errorCount: result.errorCount,
		detail: result.kind === "invalid" ? result.detail : undefined,
	};
}

/** Returns whether the edit was guarded, so {@link PatchSectionResult.validation} can report coverage. */
function assertNoNewSyntaxErrors(
	path: string,
	before: string,
	after: string,
	validator: SyntaxValidator,
): SectionValidation {
	const beforeCheck = syntaxCheck(validator({ path, text: before }));
	const afterCheck = syntaxCheck(validator({ path, text: after }));
	// One side unchecked leaves the delta undefined, so there is nothing to
	// refuse on. A file that was already broken likewise never blocks an edit.
	if (beforeCheck.kind === "unchecked" || afterCheck.kind === "unchecked") return "unchecked";
	if (afterCheck.errorCount <= beforeCheck.errorCount) return "checked";
	const gained = afterCheck.errorCount - beforeCheck.errorCount;
	const because = afterCheck.detail ? ` First error: ${afterCheck.detail}.` : "";
	throw new Error(
		`Hashline edit rejected: ${path} would gain ${gained} syntax error${gained === 1 ? "" : "s"} (${beforeCheck.errorCount} before, ${afterCheck.errorCount} after).${because} Re-read and fix the edit before writing.`,
	);
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

/**
 * High-level patcher. Wires a {@link Filesystem} and a required
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore;
	readonly recovery: Recovery;
	readonly blockResolver: BlockResolver | undefined;
	readonly applyOptions: ApplyOptions;
	readonly clipboard: Clipboard | undefined;

	readonly syntaxValidator: SyntaxValidator | undefined;
	readonly validateSyntax: boolean;
	readonly allowSyntheticContextEdits: boolean;
	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
		this.blockResolver = options.blockResolver;
		this.applyOptions = options.applyOptions ?? {};
		this.clipboard = options.clipboard;
		this.syntaxValidator = options.syntaxValidator;
		this.validateSyntax = options.validateSyntax ?? true;
		this.allowSyntheticContextEdits = options.allowSyntheticContextEdits ?? false;
	}

	/**
	 * Prepare every section before the first write, then commit sections in order.
	 * A commit failure preserves earlier writes and reports them through
	 * {@link HashlineApplyError}. Returns one {@link PatchSectionResult} per
	 * committed section in original patch order.
	 *
	 * A single-section no-op apply is returned as an `op: "noop"` result so
	 * the host can render the no-change diagnostic; a no-op inside a
	 * multi-section batch fails before any write.
	 */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		const clipboard = startClipboardBatch(this.clipboard);
		const results: PatchSectionResult[] = [];
		try {
			if (patch.sections.length === 1) {
				const prepared = await this.prepare(patch.sections[0], clipboard);
				const result = await this.commit(prepared);
				if (this.clipboard) commitClipboard(clipboard, this.clipboard);
				return { sections: [result] };
			}

			const prepared: PreparedSection[] = [];
			const sectionStates: Clipboard[] = [];
			for (const section of patch.sections) {
				prepared.push(await this.prepare(section, clipboard));
				sectionStates.push(forkClipboard(clipboard));
			}
			assertUniqueCanonicalPaths(prepared);
			for (const entry of prepared) {
				if (entry.isNoop) throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}

			for (let index = 0; index < prepared.length; index++) {
				results.push(await this.commit(prepared[index]));
				if (this.clipboard) commitClipboard(sectionStates[index], this.clipboard);
			}
			return { sections: results };
		} catch (error) {
			if (error instanceof HashlineApplyError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new HashlineApplyError(message, hashlineContract("failure", message, results));
		}
	}

	/**
	 * Run the preflight pass only: read, parse, validate, apply-in-memory.
	 * No writes hit the filesystem. Use for CI checks and dry runs.
	 */
	async preflight(patch: Patch): Promise<void> {
		const clipboard = startClipboardBatch(this.clipboard);
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section, clipboard));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the snapshot
	 * tag (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * Throws on parse error, missing tag, missing file, or unrecovered
	 * tag mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection, clipboard?: Clipboard): Promise<PreparedSection> {
		const { edits, warnings: parseWarnings, fileOp } = section.parse();
		assertSectionHashPresent(section.path, section.fileHash);

		const canonicalPath = this.fs.canonicalPath(section.path);
		if (fileOp?.kind === "move" && this.fs.canonicalPath(fileOp.dest) === canonicalPath) {
			throw new Error(`MV destination is the same as ${section.path}.`);
		}
		const { exists, rawContent } = await this.#tryRead(section.path);
		if (!exists) {
			throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`);
		}
		// After the existence check so a rejected edit cannot leave side
		// effects (e.g. a filesystem whose write preflight creates parent
		// directories).
		await this.fs.preflightWrite(section.path, { fileOp });

		const { bom, text } = stripBom(rawContent);
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const applyResult = this.#applyWithRecovery({
			section,
			canonicalPath,
			exists,
			normalized,
			edits: fileOp?.kind === "rem" ? [] : edits,
			clipboard: clipboard ?? {},
		});
		// A noop never reaches the validator, so it reports `"unchecked"`.
		const validation: SectionValidation =
			this.validateSyntax && this.syntaxValidator && applyResult.text !== normalized
				? assertNoNewSyntaxErrors(section.path, normalized, applyResult.text, this.syntaxValidator)
				: "unchecked";

		return new PreparedSection(
			section,
			canonicalPath,
			exists,
			rawContent,
			bom,
			lineEnding,
			normalized,
			applyResult,
			parseWarnings,
			fileOp,
			validation,
		);
	}

	/**
	 * Commit a previously {@link prepare}d section to the filesystem.
	 * Restores line endings and BOM, writes via the {@link Filesystem}, and
	 * records a fresh snapshot in the {@link SnapshotStore} keyed by the
	 * filesystem-canonical path.
	 */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, applyResult, canonicalPath, fileOp, validation } =
			prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);

		if (fileOp?.kind === "rem") {
			await this.fs.delete(section.path);
			this.snapshots.invalidate(canonicalPath);
			const fileHash = computeFileHash(normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "delete",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash,
				header: formatHashlineHeader(section.path, fileHash),
				warnings,
				validation,
			};
		}

		const moveDest = fileOp?.kind === "move" ? fileOp.dest : undefined;
		if (after === normalized && moveDest === undefined) {
			const fileHash = this.#recordFullSnapshot(canonicalPath, normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "noop",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash,
				header: formatHashlineHeader(section.path, fileHash),
				warnings,
				validation,
			};
		}

		const persisted = bom + restoreLineEndings(after, lineEnding);
		if (moveDest !== undefined) {
			const destination = this.fs.canonicalPath(moveDest);
			if (destination === canonicalPath) throw new Error(`MV destination is the same as ${section.path}.`);
			await this.fs.move(section.path, moveDest, persisted);
			this.snapshots.relocate(canonicalPath, destination);
			const fileHash = this.#recordFullSnapshot(destination, after);
			return {
				path: moveDest,
				canonicalPath: destination,
				op: "update",
				before: normalized,
				after,
				persisted,
				written: persisted,
				fileHash,
				header: formatHashlineHeader(moveDest, fileHash),
				firstChangedLine: applyResult.firstChangedLine,
				blockResolutions: applyResult.blockResolutions,
				moveDest,
				warnings,
				validation,
			};
		}

		const write: WriteResult = await this.fs.writeText(section.path, persisted);
		const fileHash = this.#recordFullSnapshot(canonicalPath, normalizeToLF(stripBom(write.text).text));
		return {
			path: section.path,
			canonicalPath,
			op: "update",
			before: normalized,
			after,
			persisted,
			written: write.text,
			fileHash,
			header: formatHashlineHeader(section.path, fileHash),
			firstChangedLine: applyResult.firstChangedLine,
			blockResolutions: applyResult.blockResolutions,
			warnings,
			validation,
		};
	}

	async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
		try {
			const content = await this.fs.readText(path);
			return { exists: true, rawContent: content };
		} catch (error) {
			if (isNotFound(error)) return { exists: false, rawContent: "" };
			throw error;
		}
	}

	#recordFullSnapshot(canonicalPath: string, normalized: string): string {
		return this.snapshots.record(canonicalPath, normalized);
	}

	#mismatchError(section: PatchSection, normalized: string, expected: string, hashRecognized: boolean): MismatchError {
		const actualFileHash = computeFileHash(normalized);
		return new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash,
			// Drop the empty element a trailing newline produces, matching read's textToDisplayLines (index.ts:666).
			// Keeping it made the rejection preview emit a phantom `N+1:` row, so an anchor copied out of an error
			// message retried one line too long — worst possible moment to be off by one.
			fileLines: splitDisplayLines(normalized),
			anchorLines: section.collectAnchorLines(),
			hashRecognized,
		});
	}

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
		clipboard: Clipboard;
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits, clipboard } = args;
		const expected = exists ? section.fileHash : undefined;
		const snapshot = expected !== undefined ? this.snapshots.byHash(canonicalPath, expected) : null;
		const liveMatches = snapshot !== null && snapshotProvesUnchanged(snapshot, normalized);
		const observedLineError = snapshot?.unobservedAnchorWarning(section.collectAnchorLines(), {
			allowSynthetic: this.allowSyntheticContextEdits,
		});
		const applyOptions: ApplyOptions = {
			...this.applyOptions,
			...(this.syntaxValidator ? { syntaxValidator: this.syntaxValidator } : {}),
			clipboard,
			path: section.path,
		};
		const blockWarnings: string[] = [];
		const appendBlockWarnings = (result: ApplyResult): ApplyResult => {
			const combined = [...blockWarnings, ...(result.warnings ?? [])];
			return combined.length > 0 ? { ...result, warnings: combined } : result;
		};

		// Resolve `PUT N*:` and `CUT N*` edits to concrete ranges before recovery
		// runs. Block anchors are expressed against the snapshot the section tag
		// names, so resolve against that exact text:
		//   - the tag still proves the live content → resolve against the live,
		//     normalized content;
		//   - the file drifted → resolve against the tagged snapshot's full text
		//     so the resulting ranges flow through the 3-way-merge recovery below.
		const blockResolutions: BlockResolution[] = [];
		let resolved: readonly Edit[] = edits;
		if (hasBlockEdit(edits)) {
			const baseText = expected === undefined || liveMatches ? normalized : snapshot?.fullText;
			if (baseText === undefined) {
				throw this.#mismatchError(section, normalized, expected ?? "", snapshot !== null);
			}
			resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
				onUnresolved: "throw",
				onResolved: (resolution) => blockResolutions.push(resolution),
				onWarning: (message) => blockWarnings.push(message),
			});
		}

		// A matching tag proves the content, not that the caller's numbers came from reading it: 13 of 15 corrupting
		// trials refreshed the tag correctly and still addressed pre-shift lines. Per-line hashes are checked here.
		if (expected === undefined || liveMatches) {
			if (expected !== undefined && observedLineError) throw new Error(observedLineError);
			const result = appendBlockWarnings(applyEdits(normalized, resolved, applyOptions));
			return blockResolutions.length > 0 ? { ...result, blockResolutions } : result;
		}
		// Head/tail-only inserts are position-stable: "start"/"end" cannot move
		// with content drift, so a stale tag is non-fatal. Apply onto the live
		// content and warn instead of hard-failing — unlike an anchored
		// mismatch, which cannot be safely relocated and must reject.
		if (!hasAnchorScopedEdit(resolved)) {
			const result = appendBlockWarnings(applyEdits(normalized, resolved, applyOptions));
			return { ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] };
		}
		// File drifted: try to replay the edit against the version the tag
		// names and 3-way-merge it onto the live content.
		if (snapshot) {
			const recovered = this.recovery.tryRecover({
				path: canonicalPath,
				currentText: normalized,
				fileHash: expected,
				edits: resolved,
				applyOptions,
			});
			if (recovered) return recoveryToApplyResult(appendBlockWarnings(recovered));
		}
		throw this.#mismatchError(section, normalized, expected, snapshot !== null);
	}
}
