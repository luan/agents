import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	createFindToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { githubResourceProvider } from "../shared/github-resources.ts";
import { historyResourceProvider } from "../shared/history-resources.ts";
import { readPreviewImageFromPath } from "../shared/image-preview.ts";
import { noteReadLineTotal, noteReadSelector as recordReadSelector } from "../shared/read-observations.ts";
import {
	findResources,
	isResourceUri,
	isResourceWritable,
	type PathRef,
	type ResourceContext,
	readResource,
	registerResourceProvider,
	resolvePathRef,
	searchResources,
	writeResource,
} from "../shared/resources.ts";
import { detachToolResultImages } from "../shared/tool-result-images.ts";
import { vaultResourceProvider } from "../shared/vault-resources.ts";
import {
	EDIT_DETAILS_SCHEMA,
	EDIT_VALIDATION_ENTRY_TYPE,
	editValidationCounts,
	FIND_DETAILS_SCHEMA,
	projectEditDetails,
	projectFindDetails,
	projectReadDetails,
	projectSearchDetails,
	projectWriteDetails,
	READ_DETAILS_SCHEMA,
	SEARCH_DETAILS_SCHEMA,
	WRITE_DETAILS_SCHEMA,
} from "./contracts.ts";
import {
	absolutePath,
	boundedTextResult,
	boundedWithCapture,
	buildLineEntriesWithBlockContext,
	clampLineRanges,
	conflictsReadResult,
	detectSupportedReadImageMimeType,
	displayPath,
	type EditConfig,
	type EditInput,
	executeByMode,
	FILEOPS_TOOL_SEARCH_PATHS,
	findPageSize,
	findToolSchema,
	formatHashlineHeader,
	GREP_MAX_LINE_CHARS,
	INTERNAL_FETCH_LIMIT,
	interleaveByFile,
	localResourceProvider,
	mergeLineRanges,
	modeDescription,
	modeParameters,
	normalizeToLf,
	pageWindow,
	pagingNotice,
	parseLineRange,
	prepareEditArguments,
	prepareFindArguments,
	prepareReadArguments,
	prepareSearchArguments,
	readRangeKeyReason,
	readToolSchema,
	rejectedHashRange,
	resourceContextText,
	resourceReadResult,
	rgFailure,
	SEARCH_FILE_WINDOW,
	SEARCH_NEEDS_PATTERN,
	SINGLE_FILE_ROW_BUDGET,
	searchContextLines,
	searchMatchLimit,
	searchToolSchema,
	selectedLineEntries,
	splitGlobSearchRoot,
	splitReadPathSelector,
	stripBom,
	stripHashlineDisplayPrefixes,
	type ToolTextResult,
	TREE_MATCHES_PER_FILE,
	textToDisplayLines,
	trySummarizeWholeFileRead,
	unescapedSlashPath,
	withEditTurnIndex,
	writeToolSchema,
} from "./execution.ts";

export { registerAstTools } from "./ast-tools.ts";

import { preloadBlockLanguages } from "./block-resolver.ts";
import type { InMemorySnapshotStore } from "./hashline/snapshots.ts";
import { routeReadByType } from "./read-routing.ts";

function resourceContextFromContext(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager"> | undefined,
	cwd: string,
	signal?: AbortSignal,
): ResourceContext {
	return {
		cwd,
		signal,
		sessionId: ctx?.sessionManager?.getSessionId?.(),
		sessionFile: ctx?.sessionManager?.getSessionFile?.(),
	};
}

function lineNumberInRanges(lineNumber: number, ranges: readonly { start: number; end: number }[]): boolean {
	if (ranges.length === 0) return true;
	return ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

import { recordHashlineFileSnapshot, recordHashlineSnapshot, SNAPSHOT_MAX_BYTES } from "./hashline/anchors.js";
export function registerHashlineWorkflowTools(
	registerFileopsTool: (definition: unknown) => void,
	getConfig: () => EditConfig,
	snapshotsForContext: (ctx: Pick<ExtensionContext, "sessionManager"> | undefined) => InMemorySnapshotStore,
	renderTracking: {
		latestTurnToolCallIds: Set<string>;
		markToolCall: (toolCallId: string) => void;
		getLatestTurnIndex: () => number | undefined;
	},
) {
	const cwd = process.cwd();
	const baseRead = createReadToolDefinition(cwd);
	const baseFind = createFindToolDefinition(cwd);
	const baseWrite = createWriteToolDefinition(cwd);
	registerResourceProvider("local", localResourceProvider(cwd));
	registerResourceProvider("vault", vaultResourceProvider(cwd));
	registerResourceProvider("history", historyResourceProvider());
	registerResourceProvider("pr", githubResourceProvider(cwd));
	registerResourceProvider("issue", githubResourceProvider(cwd));

	registerFileopsTool({
		...baseRead,
		name: "read",
		description: [
			// The declaration collapses `read` to positional `path: string` (tool-declarations.ts:100), which drops the
			// schema's selector grammar — renderType never reads `description` for a string. A model with only the word
			// "selector" invented `#L45-L75` from GitHub. The concrete call form has to live here, in the description,
			// because renderDeclarationBody (tool-declarations.ts:135) emits this verbatim.
			'Read a file or resource URI, with the line range on the path: `read("src/app.ts:120-180")`.',
			"Selectors: `:120` one line, `:120-180` a range, `:120+40` 40 lines from 120, `:120-` to end of file,",
			"`:12-40,90-120` several ranges, `:raw` verbatim bytes, `:conflicts` unresolved merge conflicts. Combine as `:120-180:raw`.",
			"There is no second argument: `offset`, `limit`, `line_start` and `view_range` are refused, and `#` is not a range delimiter.",
			"An unscoped read of parseable code returns a structural summary — declarations kept, bodies elided —",
			"and its footer names the exact ranges to re-read. Never guess what an elided span contains.",
			"The footer also counts the file's top-level declarations, so one unscoped read answers a count question.",
			"Archives list their entries, SQLite databases return schema and row counts, PDFs return extracted text,",
			"and other binaries return a notice instead of their bytes.",
			"Hashline mode prefixes [PATH#TAG] and LINE:TEXT rows so edits can anchor to what was displayed.",
		].join(" "),
		prepareArguments: prepareReadArguments,
		parameters: readToolSchema,
		nestedResult: { details: READ_DETAILS_SCHEMA, projectDetails: ({ details }) => projectReadDetails(details) },
		async execute(toolCallId, params: { path: string; raw?: boolean }, signal, onUpdate, ctx) {
			params = prepareReadArguments(params) as { path: string; raw?: boolean };
			const rangeKeyReason = readRangeKeyReason(params);
			if (rangeKeyReason) throw new Error(rangeKeyReason);
			if (typeof params.path !== "string" || params.path.length === 0) {
				throw new Error(
					"read requires `path`, a file path or resource URI, optionally with a `:120-180` selector.",
				);
			}
			const corrected = rejectedHashRange(params.path);
			if (corrected) throw new Error(`read path uses \`#\` for a line range; rerun with \`${corrected}\`.`);
			const callCwd = ctx?.cwd ?? cwd;
			const parsedSelector = splitReadPathSelector(params.path);
			const selector = { ...parsedSelector, raw: parsedSelector.raw || params.raw === true };
			const selectedPath = selector.path;
			// Records the path grammar only, so a `raw: true` argument does not count as a selector.
			const { ranges: selRanges, raw: selRaw, conflicts: selConflicts } = parsedSelector;
			recordReadSelector(toolCallId, selRanges.length > 0 || selRaw || selConflicts);
			// Hashline is the only edit mode that consumes line numbers; the others
			// match on verbatim text, and `:raw` asks for the bytes in any mode.
			const numbered = getConfig().mode === "hashline" && !selector.raw;
			const snapshots = numbered ? snapshotsForContext(ctx) : undefined;
			const pathRef = resolvePathRef(selectedPath, callCwd);
			if (pathRef.kind === "resource") {
				const result = await readResource(pathRef.ref, resourceContextFromContext(ctx, callCwd, signal));
				// A `LINE:` prefix anchors an `edit`, and `writeResource` rejects a scheme with no `write`.
				const writable = isResourceWritable(pathRef.ref);
				return await resourceReadResult(result, selector, writable ? snapshots : undefined, callCwd, writable);
			}

			const absolute = pathRef.path;
			const display = displayPath(callCwd, absolute);
			let fileInfo: Awaited<ReturnType<typeof stat>>;
			try {
				fileInfo = await stat(absolute);
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
				const corrected = code === "ENOENT" ? unescapedSlashPath(selectedPath) : undefined;
				if (corrected && corrected !== selectedPath) {
					throw new Error(
						"File not found: " +
							selectedPath +
							". Path carries backslash escapes; rerun `read({path: " +
							JSON.stringify(corrected) +
							"})`.",
					);
				}
				throw error;
			}
			if (fileInfo.isDirectory()) {
				throw new Error(
					"Path is a directory: " +
						display +
						". Use `find({path: " +
						JSON.stringify(selectedPath) +
						"})` to list it.",
				);
			}

			const imageMimeType = await detectSupportedReadImageMimeType(absolute);
			if (imageMimeType) {
				const result = (await baseRead.execute(
					toolCallId,
					{ path: absolute },
					signal,
					onUpdate,
					ctx,
				)) as ToolTextResult;
				const previewImage = await readPreviewImageFromPath(absolute);
				const output = previewImage ? { ...result, details: { ...(result.details ?? {}), previewImage } } : result;
				detachToolResultImages(toolCallId, output);
				return output;
			}

			// Type routing runs before the file is decoded as UTF-8: the whole point
			// is that these files have no useful text form.
			if (!selector.raw && selector.ranges.length === 0 && !selector.conflicts) {
				const routed = await routeReadByType(display, absolute, callCwd);
				if (routed) return { content: [{ type: "text", text: routed.text }], details: routed.details };
			}

			const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
			const text = normalizeToLf(rawText);
			if (selector.conflicts) {
				return await conflictsReadResult(display, absolute, text, { numbered, snapshots, cwd: callCwd });
			}
			const allLines = textToDisplayLines(text);
			noteReadLineTotal(toolCallId, allLines.length);
			const ranges = mergeLineRanges(clampLineRanges(selector.ranges, allLines.length));
			if (selector.raw) {
				const selected =
					ranges.length > 0
						? selectedLineEntries(allLines, ranges)
								.map(([, line]) => line)
								.join("\n")
						: text;
				return await boundedTextResult(selected, { ranges }, { cwd: callCwd, label: selectedPath });
			}

			if (ranges.length === 0) {
				const summary = await trySummarizeWholeFileRead(display, absolute, text, {
					numbered,
					snapshots,
					cwd: callCwd,
				});
				if (summary) return summary;
			}

			await preloadBlockLanguages([absolute]);
			const wholeFile = ranges.length === 0;
			const entries = wholeFile
				? allLines.map((line, index) => [index + 1, line] as [number, string])
				: selectedLineEntries(allLines, ranges);
			const displayEntries = wholeFile
				? entries.map(([lineNumber, line]) => ({ kind: "line" as const, lineNumber, text: line, context: false }))
				: buildLineEntriesWithBlockContext(
						allLines,
						ranges.map((range) => ({ startLine: range.start, endLine: range.end })),
						absolute,
					);
			const observedLines = wholeFile
				? "all"
				: {
						explicit: entries.map(([lineNumber]) => lineNumber),
						synthetic: displayEntries.flatMap((entry) =>
							entry.kind === "line" && entry.context ? [entry.lineNumber] : [],
						),
					};
			const tag =
				snapshots && Buffer.byteLength(text, "utf8") <= SNAPSHOT_MAX_BYTES
					? recordHashlineSnapshot(snapshots, absolute, text, observedLines)
					: undefined;
			const lastShown = wholeFile
				? allLines.length
				: Math.min(allLines.length, ranges.at(-1)?.end ?? allLines.length);
			const output = [
				...(tag ? [formatHashlineHeader(display, tag)] : []),
				...displayEntries.map((entry) =>
					entry.kind === "ellipsis" ? "…" : numbered ? `${entry.lineNumber}:${entry.text}` : entry.text,
				),
				...(lastShown < allLines.length
					? [
							"",
							`[${allLines.length - lastShown} more ${allLines.length - lastShown === 1 ? "line" : "lines"} in file. Continue with \`${display}:${lastShown + 1}-\`.]`,
						]
					: []),
			].join("\n");
			return await boundedTextResult(
				output,
				{ hashlineTag: tag, ...(wholeFile ? {} : { ranges }) },
				{ cwd: callCwd, label: selectedPath },
			);
		},
	});

	registerFileopsTool({
		name: "search",
		nestedResult: {
			details: SEARCH_DETAILS_SCHEMA,
			projectDetails: ({ details, text }) => projectSearchDetails(details, text),
		},
		label: "search",
		description: [
			"Search file contents or a resource URI for one regex. Alternation and capture groups work, so `env::var|process\\.env|Deno\\.env` finds all three spellings in one call — reach for that before a shell. Use read instead when you already know the path.",
			"This is ripgrep with the repo's ignores, a result budget, and hashline anchors. A bare `rg` loses the anchors and spends the transcript on unbounded output.",
			"Hashline mode groups local matches under [PATH#TAG] headers.",
			`Output is truncated to ${SEARCH_FILE_WINDOW} files with ${TREE_MATCHES_PER_FILE} matches each (${SINGLE_FILE_ROW_BUDGET} rows when the search is scoped to one file), 50KB, or 2000 lines, whichever is hit first.`,
			"Enclosing-block context counts against that budget. skip=N is the only way to see past the window; repeating the call returns the same page.",
			"Narrow the pattern, path, or glob to see fewer, better matches.",
			"An open-ended question — where something lives, how it flows, what calls what — is NOT a search:",
			"spawn an `investigator` agent and let it do the rounds. Never chain search calls to narrow in on an answer;",
			"a search that returns almost nothing means the question was wrong for this tool, not that the pattern needs another try.",
		].join(" "),
		promptSnippet: "Search file contents for one known pattern",
		prepareArguments: prepareSearchArguments,
		parameters: searchToolSchema,
		async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
			renderTracking.markToolCall(toolCallId);
			params = prepareSearchArguments(params) as any;
			// `search({query: "beta"})` reported "No matches found" — a false negative stated as fact, because the pattern
			// key was dropped and an absent pattern matches nothing. An empty one matched every line instead.
			if (typeof params.pattern !== "string" || params.pattern.length === 0) {
				throw new Error(SEARCH_NEEDS_PATTERN);
			}
			const callCwd = ctx?.cwd ?? cwd;
			const selector = params.path
				? isResourceUri(String(params.path))
					? { path: String(params.path), ranges: [] }
					: splitReadPathSelector(String(params.path))
				: { path: undefined, ranges: [] };
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList: string) => rangeList.split(",").map(parseLineRange)),
			];
			const contextLines = searchContextLines(params.context);
			const searchPath = selector.path;
			const pathRef = searchPath ? resolvePathRef(String(searchPath), callCwd) : undefined;
			if (pathRef?.kind === "resource") {
				if (params.context !== undefined) throw new Error("search `context` is only supported for local paths.");
				if (params.glob !== undefined) throw new Error("search glob is only supported for local paths.");
				if (params.ranges !== undefined) throw new Error("search ranges are only supported for local paths.");
				const hits = await searchResources({
					query: String(params.pattern),
					scope: pathRef.ref,
					literal: Boolean(params.literal),
					ignoreCase: Boolean(params.ignoreCase),
					limit: searchMatchLimit(params.limit, INTERNAL_FETCH_LIMIT),
					context: resourceContextFromContext(ctx, callCwd, signal),
				});
				if (hits.length === 0) return { content: [{ type: "text", text: "No matches found" }] };
				const window = pageWindow(hits, params.skip, SEARCH_FILE_WINDOW);
				const notice = pagingNotice(window, "results", pathRef.uri);
				const bounded = await boundedWithCapture(
					[
						window.items.map((hit) => resourceContextText(hit, hit.snippet)).join("\n\n"),
						...(notice ? [notice] : []),
					].join("\n\n"),
					{ cwd: callCwd, label: `search ${params.pattern}` },
				);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: { resources: window.items, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
				};
			}
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.glob) args.push("--glob", String(params.glob));
			if (explicitRanges.length === 0)
				args.push("--max-count", String(searchMatchLimit(params.limit, INTERNAL_FETCH_LIMIT)));
			args.push("--context", String(contextLines));
			const root = pathRef?.kind === "local" ? displayPath(callCwd, pathRef.path) : ".";
			if (
				searchPath &&
				!(await stat(pathRef?.kind === "local" ? pathRef.path : absolutePath(callCwd, root)).catch(() => undefined))
			) {
				throw new Error(`Search path not found: ${searchPath}`);
			}
			const runSearch = (literal: boolean) =>
				runExternalCommand(
					"rg",
					[...args, ...(literal ? ["--fixed-strings"] : []), "--", String(params.pattern), root],
					callCwd,
					{ signal, allowNonZero: true, extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS },
				);
			let literalRetry = false;
			let result = await runSearch(params.literal === true);
			if (params.literal === undefined && result.exitCode > 1 && /regex parse error/i.test(result.stderr)) {
				result = await runSearch(true);
				literalRetry = true;
			}
			const searchFailure = rgFailure(result, "search could not run", "Check the search root and permissions.");
			if (searchFailure) throw searchFailure;
			if (result.exitCode === 1 || result.stdout.trim().length === 0) {
				return { content: [{ type: "text", text: "No matches found" }] };
			}
			const byFile = new Map<string, Map<number, { text: string; isMatch: boolean }>>();
			for (const line of result.stdout.replace(/\r\n?/g, "\n").split("\n")) {
				if (!line.trim() || line === "--") continue;
				const singleFileMatch = searchPath ? /^([1-9]\d*)([:-])(.*)$/.exec(line) : undefined;
				const match = singleFileMatch ? undefined : /^(.*?)([:-])([1-9]\d*)([:-])(.*)$/.exec(line);
				if (!match && !singleFileMatch) continue;
				const absolute = match ? absolutePath(callCwd, match[1]) : absolutePath(callCwd, String(searchPath));
				const lineNumber = Number(match ? match[3] : singleFileMatch?.[1]);
				if (!lineNumberInRanges(lineNumber, explicitRanges)) continue;
				const isMatch = (match ? match[2] : singleFileMatch?.[2]) === ":";
				const fileLines = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				fileLines.set(lineNumber, { text: match ? match[5] : (singleFileMatch?.[3] ?? ""), isMatch });
				byFile.set(absolute, fileLines);
			}
			if (byFile.size === 0) return { content: [{ type: "text", text: "No matches found in selected ranges" }] };
			await preloadBlockLanguages(byFile.keys());
			const orderedFiles = [...byFile.entries()]
				.map(([absolute, entries]) => {
					const ordered = [...entries.entries()].sort((left, right) => left[0] - right[0]);
					return { absolute, ordered, matches: ordered.filter(([, entry]) => entry.isMatch) };
				})
				.sort((left, right) => left.absolute.localeCompare(right.absolute));
			const fileWindow = pageWindow(orderedFiles, params.skip, SEARCH_FILE_WINDOW);
			// One matching file means the search is a strided read of that file, so
			// the budget is spent on rows there instead of on breadth.
			const singleFileScope = orderedFiles.length === 1;
			const basePerFileCap = singleFileScope ? SINGLE_FILE_ROW_BUDGET : TREE_MATCHES_PER_FILE;
			const baseRowBudget = singleFileScope ? SINGLE_FILE_ROW_BUDGET : SEARCH_FILE_WINDOW * TREE_MATCHES_PER_FILE;
			const resultLimit = searchMatchLimit(params.limit, baseRowBudget);
			const perFileCap = Math.min(basePerFileCap, resultLimit);
			const rowBudget = Math.min(baseRowBudget, resultLimit);
			// Rotate first, cap second. Capping during the rotation would hand the
			// budget to whichever files sort first — the bias the rotation removes.
			const rotated = interleaveByFile(
				fileWindow.items.map((file) => file.matches.map((match) => ({ absolute: file.absolute, match }))),
				perFileCap,
			);
			const availableMatches = fileWindow.items.reduce((total, file) => total + file.matches.length, 0);
			const selected = rotated.slice(0, rowBudget);
			let truncatedSearch = selected.length < availableMatches;
			const selectedByFile = new Map<string, [number, { text: string; isMatch: boolean }][]>();
			for (const { absolute, match } of selected) {
				const list = selectedByFile.get(absolute) ?? [];
				list.push(match);
				selectedByFile.set(absolute, list);
			}
			const sections: string[] = [];
			const highlightedSections: { path: string; rows: string[] }[] = [];
			let emittedRows = 0;
			for (const { absolute } of fileWindow.items) {
				const fileEntries = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				// Context rows explain selected matches but do not consume the match cap.
				const selectedMatches = selectedByFile.get(absolute) ?? [];
				const selectedMatchLines = new Set(selectedMatches.map(([lineNumber]) => lineNumber));
				const cappedOrdered = [...fileEntries.entries()]
					.filter(
						([lineNumber, entry]) =>
							selectedMatchLines.has(lineNumber) ||
							(!entry.isMatch &&
								[...selectedMatchLines].some((matchLine) => Math.abs(matchLine - lineNumber) <= contextLines)),
					)
					.sort((left, right) => left[0] - right[0]);
				if (emittedRows >= rowBudget) {
					truncatedSearch = true;
					break;
				}
				const display = displayPath(callCwd, absolute);
				const rawFile = normalizeToLf((await readFile(absolute, "utf-8")).replace(/^\uFEFF/, ""));
				const fullLines = textToDisplayLines(rawFile);
				const entryText = new Map(cappedOrdered.map(([lineNumber, entry]) => [lineNumber, entry.text] as const));
				const expanded = buildLineEntriesWithBlockContext(
					fullLines,
					cappedOrdered.map(([lineNumber]) => ({ startLine: lineNumber, endLine: lineNumber })),
					absolute,
					{ lineText: (lineNumber, sourceText) => entryText.get(lineNumber) ?? sourceText },
				);
				// Enclosing-block lines are added after the match cap, so they are the
				// part of the cost the cap never saw. Charge them to the same budget.
				const displayEntries: typeof expanded = [];
				let fileRows = 0;
				for (const entry of expanded) {
					if (entry.kind === "line") {
						if (emittedRows + fileRows >= rowBudget) {
							truncatedSearch = true;
							break;
						}
						fileRows += 1;
					}
					displayEntries.push(entry);
				}
				emittedRows += fileRows;
				if (fileRows === 0) continue;
				const tag = await recordHashlineFileSnapshot(snapshotsForContext(ctx), absolute, {
					explicit: displayEntries.flatMap((entry) =>
						entry.kind === "line" && !entry.context ? [entry.lineNumber] : [],
					),
					synthetic: displayEntries.flatMap((entry) =>
						entry.kind === "line" && entry.context ? [entry.lineNumber] : [],
					),
				});
				const rows = displayEntries.map((entry) => {
					if (entry.kind === "ellipsis") return "…";
					const isMatch = fileEntries.get(entry.lineNumber)?.isMatch === true;
					return `${isMatch ? "*" : " "}${entry.lineNumber}:${entry.text}`;
				});
				highlightedSections.push({ path: display, rows });
				sections.push((tag ? [formatHashlineHeader(display, tag), ...rows] : rows).join("\n"));
			}
			if (literalRetry) sections.unshift("Pattern treated as literal text because it did not parse as a regex.");
			const notices: string[] = [];
			const paging = pagingNotice(fileWindow);
			if (paging) notices.push(paging);
			if (truncatedSearch)
				notices.push(
					`Match budget reached: at most ${perFileCap} matches per file and ${rowBudget} rows total, enclosing-block context included. Narrow the pattern, path, or glob to see the rest.`,
				);
			if (notices.length > 0) sections.push(notices.join(" "));
			// Search is one-match-per-line, so a single minified line is noise here
			// and capping it is safe. Document reads deliberately do not do this.
			const bounded = await boundedWithCapture(
				sections.join("\n\n"),
				{ cwd: callCwd, label: `search ${params.pattern}` },
				{ maxLineChars: GREP_MAX_LINE_CHARS },
			);
			return {
				content: [{ type: "text", text: bounded.text }],
				details: { highlightedSections, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
			};
		},
	});

	registerFileopsTool({
		...baseFind,
		name: "find",
		nestedResult: { details: FIND_DETAILS_SCHEMA, projectDetails: ({ details }) => projectFindDetails(details) },
		description: [
			"Find files or resources by glob or path, one independent entry per question.",
			`Output is truncated to ${SEARCH_FILE_WINDOW} files or 50KB, whichever is hit first.`,
			"skip=N is the only way to see past the window; repeating the call returns the same page. Narrow the glob to need fewer pages.",
		].join(" "),
		prepareArguments: prepareFindArguments,
		parameters: findToolSchema,
		async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
			renderTracking.markToolCall(toolCallId);
			params = prepareFindArguments(params) as any;
			if (Array.isArray(params.paths) && (params.path !== undefined || params.pattern !== undefined)) {
				throw new Error("find cannot combine paths with path or pattern.");
			}
			const pageSize = findPageSize(params.limit);
			const callCwd = ctx?.cwd ?? cwd;
			const requestedPaths = Array.isArray(params.paths)
				? params.paths.map(String)
				: [params.path ?? params.pattern].filter((value): value is string => typeof value === "string");
			const pathRefs = requestedPaths.map((path) => resolvePathRef(path, callCwd));
			const resourceRefs = pathRefs.filter(
				(ref): ref is Extract<PathRef, { kind: "resource" }> => ref.kind === "resource",
			);
			if (resourceRefs.length > 0) {
				if (resourceRefs.length !== requestedPaths.length) {
					throw new Error("find cannot mix resource URIs with local paths.");
				}
				if (params.hidden !== undefined) throw new Error("find hidden is only supported for local paths.");
				if (params.gitignore !== undefined) throw new Error("find gitignore is only supported for local paths.");
				const found = (
					await Promise.all(
						resourceRefs.map(({ ref }) => findResources(ref, resourceContextFromContext(ctx, callCwd, signal))),
					)
				).flat();
				const window = pageWindow(found, params.skip, pageSize);
				const notice = pagingNotice(window, "resources", resourceRefs[0]?.uri);
				const bounded = await boundedWithCapture(
					window.items.length === 0
						? "No resources found"
						: [
								window.items.map((item) => resourceContextText(item)).join("\n\n"),
								...(notice ? [notice] : []),
							].join("\n\n"),
					{ cwd: callCwd, label: "find" },
				);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: { resources: window.items, outputTokens: bounded.tokens, outputBounded: bounded.truncated },
				};
			}
			// The legacy `{pattern, path}` shape is the one a model reaches for most
			// naturally, and delegating it to the base tool skipped the window, the
			// paging notice and the byte budget entirely. Normalise it instead so
			// there is exactly one bounded path through this tool.
			// Every field of findToolSchema is Optional, so `{path}` and `{}` are both valid calls. Delegating either to
			// the base tool reached an unguarded `pattern.includes("/")` (pi-coding-agent find.js:189) and threw; a probe
			// caught it on the opening move of 12 of 24 trials. `**` is what a caller means: everything under the path.
			const requestedPattern =
				typeof params.pattern === "string" && params.pattern.length > 0 ? params.pattern : "**";
			const rawGlobPaths = Array.isArray(params.paths)
				? params.paths
				: [join(typeof params.path === "string" && params.path ? params.path : ".", requestedPattern)];
			const globPaths = rawGlobPaths.map((pattern: string) => {
				const ref = resolvePathRef(String(pattern), callCwd);
				if (ref.kind !== "local") throw new Error("find cannot use resource URIs as local globs.");
				return ref.path;
			});
			const perPattern: string[][] = [];
			for (const pattern of globPaths) {
				const search = splitGlobSearchRoot(callCwd, String(pattern));
				const rootStat = await stat(search.root).catch(() => undefined);
				if (!rootStat?.isDirectory()) continue;
				const args = ["--files", "--color=never"];
				if (!params.gitignore) args.push("--no-ignore");
				if (params.hidden) args.push("--hidden");
				args.push("--glob", search.glob);
				const result = await runExternalCommand("rg", args, search.root, {
					signal,
					allowNonZero: true,
					extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
				});
				const globFailure = rgFailure(
					result,
					"find could not run that glob",
					`Check the glob \`${search.glob}\`: it must be a valid glob such as \`**/*.swift\`.`,
				);
				if (globFailure) throw globFailure;
				perPattern.push(
					result.stdout
						.split("\n")
						.filter(Boolean)
						.map((file) => displayPath(callCwd, absolutePath(search.root, file)))
						.sort((left, right) => left.localeCompare(right)),
				);
			}
			// Rotate across the requested patterns so one broad glob cannot spend the
			// whole page and hide the narrow pattern the caller also asked for.
			const seen = new Set<string>();
			const allUnique = interleaveByFile(perPattern, INTERNAL_FETCH_LIMIT).filter((file) => {
				if (seen.has(file)) return false;
				seen.add(file);
				return true;
			});
			const window = pageWindow(allUnique, params.skip, pageSize);
			const notice = pagingNotice(window);
			const bounded = await boundedWithCapture(
				window.items.length === 0
					? "No files found matching pattern"
					: [
							...[...window.items].sort((left, right) => left.localeCompare(right)),
							...(notice ? [notice] : []),
						].join("\n"),
				{ cwd: callCwd, label: "find" },
			);
			return {
				content: [{ type: "text", text: bounded.text }],
				details: { outputTokens: bounded.tokens, outputBounded: bounded.truncated },
			};
		},
	});

	registerFileopsTool({
		...baseWrite,
		name: "write",
		description:
			"Write a file or writable resource URI. In hashline mode, copied [PATH#TAG] and LINE: prefixes are stripped from content before writing.",
		parameters: writeToolSchema,
		nestedResult: { details: WRITE_DETAILS_SCHEMA, projectDetails: ({ details }) => projectWriteDetails(details) },
		async execute(
			toolCallId,
			params: { path: string; content: string; makeExecutable?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			onUpdate?.({ content: [{ type: "text", text: "Writing..." }], details: {} });
			const callCwd = ctx?.cwd ?? cwd;
			const pathRef = resolvePathRef(params.path, callCwd);
			if (pathRef.kind === "resource") {
				const stripped =
					getConfig().mode === "hashline"
						? stripHashlineDisplayPrefixes(params.content)
						: { text: params.content, stripped: false };
				const result = await writeResource(pathRef.ref, {
					content: stripped.text,
					makeExecutable: params.makeExecutable,
					context: resourceContextFromContext(ctx, callCwd, signal),
				});
				return {
					content: [{ type: "text", text: `Wrote ${result.resource.uri}` }],
					details: { resource: result.resource, bytes: result.bytes },
				};
			}
			if (getConfig().mode !== "hashline")
				return baseWrite.execute(toolCallId, { ...params, path: pathRef.path }, signal, onUpdate, ctx);
			const stripped = stripHashlineDisplayPrefixes(params.content);
			const absolute = pathRef.path;
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, stripped.text, "utf-8");
			if (params.makeExecutable || stripped.text.startsWith("#!")) await chmod(absolute, 0o755);
			snapshotsForContext(ctx).invalidate(absolute);
			const result: ToolTextResult = {
				content: [{ type: "text", text: `Wrote ${params.path}` }],
				details: {},
			};
			if (stripped.stripped) {
				const first = result.content.find(
					(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
				);
				if (first) first.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
			}
			return result;
		},
	});
}
export function registerEditTool(
	registerFileopsTool: (definition: unknown) => void,
	getConfig: () => EditConfig,
	snapshotsForContext: (ctx: Pick<ExtensionContext, "sessionManager"> | undefined) => InMemorySnapshotStore,
	renderTracking: {
		latestTurnToolCallIds: Set<string>;
		markToolCall: (toolCallId: string) => void;
		getLatestTurnIndex: () => number | undefined;
	},
): void {
	const current = getConfig();
	registerFileopsTool({
		name: "edit",
		label: "edit",
		description: modeDescription(current),
		promptSnippet:
			"Change lines in a file you have read. Anchors on the tag and line numbers that read/search printed.",
		parameters: modeParameters(),
		prepareArguments: prepareEditArguments,
		nestedResult: {
			details: EDIT_DETAILS_SCHEMA,
			projectDetails: ({ details }) => projectEditDetails(details),
			recordEntry: ({ details }) => {
				const counts = editValidationCounts(details);
				return counts ? { customType: EDIT_VALIDATION_ENTRY_TYPE, data: counts } : undefined;
			},
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			renderTracking.markToolCall(toolCallId);
			onUpdate?.({ content: [{ type: "text", text: "Editing..." }], details: {} });
			return withEditTurnIndex(
				await executeByMode(
					ctx.cwd,
					params as EditInput,
					current,
					snapshotsForContext(ctx),
					signal,
					resourceContextFromContext(ctx, ctx.cwd, signal),
					ctx.sessionManager?.getBranch?.() ?? [],
				),
				renderTracking.getLatestTurnIndex(),
			);
		},
	});
}
