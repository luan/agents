import {
	fetchGitHubComments,
	fetchGitHubItem,
	fetchPullRequestChecks,
	fetchPullRequestFile,
	fetchPullRequestFiles,
	fetchPullRequestThread,
	fetchPullRequestThreads,
	type GitHubKind,
	type GitHubRecord,
	type GitHubTarget,
	listGitHubItems,
	replyToPullRequestThread,
	setPullRequestThreadResolved,
} from "./github-client.ts";
import {
	formatResourceUri,
	type ReadResult,
	type Resource,
	type ResourceCapabilities,
	type ResourceContext,
	ResourceError,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
	type WriteRequest,
	type WriteResult,
} from "./resources.ts";

const COLLECTION_LIMIT = 100;
const COMMENT_PREVIEW_CHARS = 140;

function target(ref: ResourceRef): GitHubTarget {
	const segments = ref.path.replace(/^\/+/, "").split("/").filter(Boolean);
	const rest = (from: number) => (segments.length > from ? segments.slice(from).join("/") : undefined);
	if (ref.authority === "current") {
		return { number: segments[0], view: segments[1], selector: rest(2) };
	}
	if (ref.authority === "github.com" && segments.length >= 2) {
		return {
			repo: `${segments[0]}/${segments[1]}`,
			number: segments[2],
			view: segments[3],
			selector: rest(4),
		};
	}
	const repo = segments.shift();
	return {
		repo: repo ? `${ref.authority}/${repo}` : undefined,
		number: segments[0],
		view: segments[1],
		selector: segments.length > 2 ? segments.slice(2).join("/") : undefined,
	};
}

function githubKind(scheme: ResourceRef["scheme"]): GitHubKind {
	if (scheme === "pr" || scheme === "issue") return scheme;
	throw new Error(`Unsupported GitHub resource scheme: ${scheme}`);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function listValue(value: unknown): GitHubRecord[] {
	return Array.isArray(value)
		? value.filter((item): item is GitHubRecord => Boolean(item) && typeof item === "object")
		: [];
}

function repositoryFromUrl(value: unknown): string | undefined {
	const url = stringValue(value);
	if (!url) return undefined;
	return /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1];
}

function repositoryFor(record: GitHubRecord, targetValue: GitHubTarget): string | undefined {
	return targetValue.repo ?? stringValue(record.repository) ?? repositoryFromUrl(record.url);
}

function resourceFor(
	ref: ResourceRef,
	record: GitHubRecord,
	kind: string,
	content?: string,
	mediaType = "text/plain",
): Resource {
	const repository = repositoryFor(record, target(ref));
	return {
		uri: formatResourceUri(ref),
		name: String(record.number ?? record.databaseId ?? record.id ?? ref.path),
		title: stringValue(record.title) ?? stringValue(record.name),
		kind,
		mediaType,
		size: content === undefined ? undefined : Buffer.byteLength(content, "utf8"),
		modifiedAt: stringValue(record.updatedAt) ?? stringValue(record.updated_at),
		version: stringValue(record.headRefOid) ?? stringValue(record.updatedAt) ?? stringValue(record.updated_at),
		metadata: repository ? { ...record, repository } : record,
	};
}

/**
 * GitHub shares one numbering space between issues and pull requests, so `issue://owner/repo/1` can resolve to a pull
 * request: `gh issue view 1` answers with the pull request, `state` of `MERGED` and a `/pull/1` url. Both the card and
 * the body report what came back rather than what the scheme asked for.
 */
export function githubRecordIsPullRequest(record: GitHubRecord): boolean {
	if (record.pull_request !== undefined || record.headRefName !== undefined) return true;
	if (stringValue(record.mergedAt) || stringValue(record.state)?.toUpperCase() === "MERGED") return true;
	return /\/pull\/\d+(?:$|[/?#])/.test(stringValue(record.url) ?? "");
}

/** `gh` marshals a GitHub App actor as login `app/<slug>`, and the slug is empty for some apps. */
export function githubAppSlug(login: string): string | undefined {
	return login.startsWith("app/") ? login.slice(4) : undefined;
}

/** A `@app/` header and an `Author: app/` body both came from taking gh's bare app login as a username. */
export function githubAuthorLabel(login: string, name?: string): string {
	const slug = githubAppSlug(login);
	if (slug === undefined) return login;
	return slug ? `${slug} (app)` : (name ?? "GitHub App");
}

function authorName(value: unknown): string | undefined {
	if (typeof value === "string") return value.replace(/^@/, "");
	if (!value || typeof value !== "object") return undefined;
	const record = value as GitHubRecord;
	const login = stringValue(record.login);
	if (login) return githubAuthorLabel(login, stringValue(record.name));
	return stringValue(record.name);
}

function labelNames(value: unknown): string[] {
	return listValue(value)
		.map((label) => stringValue(label.name))
		.filter((label): label is string => Boolean(label));
}

export function sanitizeMarkdown(value: string): string {
	const fences: string[] = [];
	const guarded = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (fence) => {
		fences.push(fence);
		return `\u0000fence${fences.length - 1}\u0000`;
	});
	const stripped = guarded
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<img\b[^>]*>/gi, "")
		.replace(
			/<\/?(?:a|span|div|p|b|i|em|strong|sub|sup|picture|source|font|center|h[1-6]|details|summary|table|thead|tbody|tr|td|th)\b[^>]*>/gi,
			"",
		)
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n");
	return stripped.replace(/\u0000fence(\d+)\u0000/g, (_match, index) => fences[Number(index)] ?? "");
}

function pushField(lines: string[], label: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	lines.push(`**${label}:** ${String(value)}`);
}

function renderItem(kind: GitHubKind, record: GitHubRecord): string {
	const number = String(record.number ?? "?");
	const title = stringValue(record.title) ?? "Untitled";
	const pullRequest = kind === "pr" || githubRecordIsPullRequest(record);
	const lines = [`# ${pullRequest ? "Pull request" : "Issue"} #${number}: ${title}`, ""];
	pushField(lines, "State", record.state);
	if (kind === "pr") {
		pushField(lines, "Draft", record.isDraft);
		pushField(lines, "Base", record.baseRefName);
		pushField(lines, "Head", record.headRefName);
		pushField(lines, "Review", record.reviewDecision);
		pushField(lines, "Merge state", record.mergeStateStatus);
	}
	pushField(lines, "Author", authorName(record.author));
	pushField(lines, "Updated", record.updatedAt);
	pushField(lines, "Labels", labelNames(record.labels).join(", "));
	pushField(lines, "URL", record.url);
	lines.push("", "## Body", "", sanitizeMarkdown(stringValue(record.body) ?? "No description provided."));
	return lines.join("\n").trim();
}

function preview(value: unknown): string | undefined {
	const body = typeof value === "string" ? sanitizeMarkdown(value).replace(/\s+/g, " ").trim() : "";
	if (!body) return undefined;
	return body.length <= COMMENT_PREVIEW_CHARS ? body : `${body.slice(0, COMMENT_PREVIEW_CHARS)}…`;
}

function commentId(comment: GitHubRecord): string {
	return String(comment.id ?? comment.databaseId ?? "");
}

function projectComment(comment: GitHubRecord): GitHubRecord {
	return {
		id: comment.id ?? comment.databaseId,
		author: comment.author ?? comment.user,
		date: comment.createdAt ?? comment.created_at,
		body: sanitizeMarkdown(String(comment.body ?? comment.bodyText ?? "")),
		url: comment.url ?? comment.html_url,
	};
}

function commentLine(comment: GitHubRecord): string {
	const author = authorName(comment.author ?? comment.user) ?? "?";
	const date = String(comment.date ?? comment.createdAt ?? comment.created_at ?? "").slice(0, 10);
	return `${commentId(comment)} @${author} ${date} ${preview(comment.body ?? comment.bodyText) ?? ""}`.trim();
}

function itemResult(
	ref: ResourceRef,
	base: GitHubRecord,
	item: GitHubRecord,
	kind: string,
	content: string,
): ReadResult {
	const record = { ...base, ...item };
	const url = stringValue(record.url);
	const output = url ? `${content}\n\n**URL:** ${url}` : content;
	return { resource: resourceFor(ref, record, kind, output, "text/markdown"), content: output };
}

function listingResult(
	ref: ResourceRef,
	base: GitHubRecord,
	items: GitHubRecord[],
	kind: string,
	lines: string[],
): ReadResult {
	const content =
		lines.length > 0 ? lines.join("\n") : `No ${kind.replace(/^(?:pull-request|github)-/, "").replace(/-/g, " ")}.`;
	return { resource: resourceFor(ref, { ...base, items }, kind, content), content };
}

async function readComments(
	ref: ResourceRef,
	kind: GitHubKind,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	const base = await fetchGitHubComments(kind, targetValue, context, baseCwd);
	const comments = listValue(base.comments);
	if (targetValue.selector) {
		const comment = comments.find((item) => commentId(item) === targetValue.selector);
		if (!comment) throw new ResourceError("not_found", `GitHub comment not found: ${formatResourceUri(ref)}`);
		const projected = projectComment(comment);
		return itemResult(ref, base, projected, "github-comment", String(projected.body ?? ""));
	}
	const projected = comments.map((comment) => ({
		...projectComment(comment),
		body: preview(comment.body ?? comment.bodyText),
	}));
	return listingResult(ref, base, projected, "github-comments", comments.map(commentLine));
}

function projectFile(file: GitHubRecord, base: GitHubRecord): GitHubRecord {
	const path = file.filename ?? file.path;
	const repository = repositoryFromUrl(base.url);
	const headSha = stringValue(base.headRefOid);
	const blobUrl =
		file.blob_url ??
		(repository && headSha && typeof path === "string"
			? `https://github.com/${repository}/blob/${headSha}/${path
					.split("/")
					.map((segment) => encodeURIComponent(segment))
					.join("/")}`
			: undefined);
	return {
		filename: path,
		status: file.status ?? file.changeType,
		additions: file.additions,
		deletions: file.deletions,
		previousFilename: file.previous_filename,
		patch: file.patch,
		url: blobUrl,
	};
}

async function readFiles(
	ref: ResourceRef,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	if (targetValue.selector) {
		const base = await fetchGitHubItem("pr", targetValue, context, baseCwd);
		const repository = repositoryFor(base, targetValue);
		const file = await fetchPullRequestFile(
			repository ? { ...targetValue, repo: repository } : targetValue,
			targetValue.selector,
			context,
			baseCwd,
		);
		if (!file) throw new ResourceError("not_found", `Pull request file not found: ${formatResourceUri(ref)}`);
		const projected = projectFile(file, base);
		const content = String(projected.patch ?? "No patch available.");
		return itemResult(ref, base, projected, "pull-request-file", content);
	}
	const base = await fetchPullRequestFiles(targetValue, context, baseCwd);
	const files = listValue(base.files).map((file) => projectFile(file, base));
	const lines = files.map(
		(file) =>
			`${String(file.status ?? "changed")
				.slice(0, 1)
				.toUpperCase()} +${file.additions ?? 0} -${file.deletions ?? 0} ${String(file.filename ?? "")}`,
	);
	return listingResult(ref, base, files, "pull-request-files", lines);
}

function projectCheck(check: GitHubRecord): GitHubRecord {
	return {
		name: check.name ?? check.context,
		status: check.status,
		conclusion: check.conclusion ?? check.state,
		workflowName: check.workflowName,
		url: check.detailsUrl ?? check.targetUrl,
	};
}

async function readChecks(
	ref: ResourceRef,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	const base = await fetchPullRequestChecks(targetValue, context, baseCwd);
	const checks = listValue(base.statusCheckRollup).map(projectCheck);
	const lines = checks.map(
		(check) =>
			`${String(check.name ?? "check")} · ${String(check.conclusion ?? check.status ?? "pending").toLowerCase()}`,
	);
	return listingResult(ref, base, checks, "pull-request-checks", lines);
}

function pullRequestFromThreads(data: GitHubRecord): GitHubRecord | undefined {
	const repository = data.repository;
	if (!repository || typeof repository !== "object" || Array.isArray(repository)) return undefined;
	const pullRequest = (repository as GitHubRecord).pullRequest;
	return pullRequest && typeof pullRequest === "object" && !Array.isArray(pullRequest)
		? (pullRequest as GitHubRecord)
		: undefined;
}

function projectThread(thread: GitHubRecord): GitHubRecord {
	const comments = thread.comments && typeof thread.comments === "object" ? (thread.comments as GitHubRecord) : {};
	const nodes = listValue(comments.nodes);
	return {
		id: thread.id,
		path: thread.path,
		line: thread.line,
		isResolved: thread.isResolved === true,
		diffHunk: nodes.find((comment) => stringValue(comment.diffHunk))?.diffHunk,
		url: nodes.find((comment) => stringValue(comment.url))?.url,
		comments: {
			totalCount: Number(comments.totalCount ?? nodes.length),
			nodes: nodes.map((comment) => ({
				author: comment.author,
				body: sanitizeMarkdown(String(comment.bodyText ?? "")),
			})),
		},
	};
}

function renderThread(thread: GitHubRecord): string {
	const comments = thread.comments && typeof thread.comments === "object" ? (thread.comments as GitHubRecord) : {};
	const nodes = listValue(comments.nodes);
	const rendered = nodes
		.map((comment) => {
			const author = authorName(comment.author);
			const body = stringValue(comment.body) ?? "";
			return author ? `@${author}: ${body}` : body;
		})
		.join("\n\n---\n\n");
	const omitted = Number(comments.totalCount ?? nodes.length) - nodes.length;
	return omitted > 0 ? `${rendered}\n\n_${omitted} more comments not shown._` : rendered;
}

function renderThreadListItem(thread: GitHubRecord): string {
	const line = thread.line === undefined || thread.line === null ? "" : `:${String(thread.line)}`;
	const heading =
		`## ${String(thread.path ?? "")}${line} · ` +
		`${thread.isResolved === true ? "resolved" : "unresolved"} · ${String(thread.id ?? "")}`;
	return `${heading}\n\n${renderThread(thread) || "No comments."}`;
}

async function readThreads(
	ref: ResourceRef,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	if (targetValue.selector) {
		const [base, thread] = await Promise.all([
			fetchGitHubItem("pr", targetValue, context, baseCwd),
			fetchPullRequestThread(targetValue.selector, context, baseCwd),
		]);
		if (!thread) throw new ResourceError("not_found", `Pull request thread not found: ${formatResourceUri(ref)}`);
		const projected = projectThread(thread);
		return itemResult(ref, base, projected, "pull-request-thread", renderThread(projected));
	}
	const data = await fetchPullRequestThreads(targetValue, context, baseCwd);
	const base = pullRequestFromThreads(data);
	if (!base) throw new ResourceError("not_found", `Pull request not found: ${formatResourceUri(ref)}`);
	const reviewThreads =
		base.reviewThreads && typeof base.reviewThreads === "object" ? (base.reviewThreads as GitHubRecord) : {};
	const nodes = listValue(reviewThreads.nodes);
	let selected = nodes;
	if ("unresolved" in ref.query) selected = selected.filter((thread) => thread.isResolved !== true);
	const lines = selected.map(projectThread).map(renderThreadListItem);
	const omitted = Number(reviewThreads.totalCount ?? nodes.length) - nodes.length;
	if (omitted > 0) lines.push(`_${omitted} more review threads not shown._`);
	return listingResult(ref, base, selected.map(projectThread), "pull-request-threads", lines);
}

function threadWriteResult(ref: ResourceRef, thread: GitHubRecord, content: string): WriteResult {
	return {
		resource: resourceFor(ref, thread, "pull-request-thread", content, "text/markdown"),
		bytes: Buffer.byteLength(content, "utf8"),
	};
}

function normalizeThreadContent(value: string): string {
	return value.replace(/\r\n/g, "\n").trim();
}

async function writeThread(
	ref: ResourceRef,
	request: WriteRequest,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<WriteResult> {
	const targetValue = target(ref);
	if (!targetValue.selector || targetValue.view !== "threads") {
		throw new ResourceError(
			"unsupported_action",
			`Only pull request threads can be written: ${formatResourceUri(ref)}`,
		);
	}
	assertQuery(ref, []);
	const current = await fetchPullRequestThread(targetValue.selector, context, baseCwd);
	if (!current) throw new ResourceError("not_found", `Pull request thread not found: ${formatResourceUri(ref)}`);
	const before = projectThread(current);
	const beforeContent = normalizeThreadContent(renderThread(before));
	if (request.expectedContent !== undefined && normalizeThreadContent(request.expectedContent) !== beforeContent) {
		throw new ResourceError(
			"validation_failed",
			`Pull request thread changed before write: ${formatResourceUri(ref)}`,
		);
	}

	const afterContent = normalizeThreadContent(request.content);
	if (afterContent === beforeContent) return threadWriteResult(ref, before, renderThread(before));
	if (afterContent.length === 0) {
		await setPullRequestThreadResolved(targetValue.selector, true, context, baseCwd);
		const resolved = { ...before, isResolved: true };
		return threadWriteResult(ref, resolved, "");
	}
	const shouldUnresolve = before.isResolved === true;

	const prefix = beforeContent.length > 0 ? `${beforeContent}\n\n---\n\n` : "";
	if (!afterContent.startsWith(prefix)) {
		throw new ResourceError(
			"validation_failed",
			`Thread writes can only append a reply or clear content to resolve: ${formatResourceUri(ref)}`,
		);
	}
	const reply = afterContent.slice(prefix.length).trim();
	if (reply.length === 0 || reply.includes("\n\n---\n\n")) {
		throw new ResourceError(
			"validation_failed",
			`Thread writes can append exactly one reply: ${formatResourceUri(ref)}`,
		);
	}
	await replyToPullRequestThread(targetValue.selector, reply, context, baseCwd);
	if (shouldUnresolve) {
		await setPullRequestThreadResolved(targetValue.selector, false, context, baseCwd);
	}
	return threadWriteResult(ref, { ...before, isResolved: false }, afterContent);
}

function assertQuery(ref: ResourceRef, allowed: readonly string[]): void {
	const unsupported = Object.keys(ref.query).filter((key) => !allowed.includes(key));
	if (unsupported.length > 0) {
		throw new ResourceError(
			"validation_failed",
			`Unsupported GitHub query parameter${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
		);
	}
}

async function readGitHubView(
	ref: ResourceRef,
	kind: GitHubKind,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	assertQuery(ref, targetValue.view === "threads" ? ["unresolved"] : []);
	if (targetValue.view === "comments") return readComments(ref, kind, targetValue, context, baseCwd);
	if (kind === "pr" && targetValue.view === "files") return readFiles(ref, targetValue, context, baseCwd);
	if (kind === "pr" && targetValue.view === "checks") return readChecks(ref, targetValue, context, baseCwd);
	if (kind === "pr" && targetValue.view === "threads") return readThreads(ref, targetValue, context, baseCwd);
	throw new ResourceError("unsupported_view", `Unsupported GitHub view: ${formatResourceUri(ref)}`);
}

function collectionLimit(value: string | undefined, fallback = 50): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(COLLECTION_LIMIT, Math.floor(parsed))) : fallback;
}

function collectionItemRef(ref: ResourceRef, number: string): ResourceRef {
	return {
		...ref,
		path: `${ref.path.replace(/\/+$/, "")}/${number}`,
		fragment: undefined,
		query: {},
	};
}

function listedResource(ref: ResourceRef, record: GitHubRecord, kind: GitHubKind): Resource {
	return resourceFor(collectionItemRef(ref, String(record.number)), record, kind);
}

function githubCapabilities(ref: ResourceRef): ResourceCapabilities {
	const kind = githubKind(ref.scheme);
	return {
		providerVersion: "github-resource-v2",
		views: kind === "pr" ? ["comments", "checks", "files", "threads"] : ["comments"],
		fields: [],
	};
}

export function githubResourceProvider(baseCwd: string): ResourceProvider {
	return {
		async read(ref, context) {
			const kind = githubKind(ref.scheme);
			const targetValue = target(ref);
			if (ref.fragment)
				throw new ResourceError("unsupported_view", `GitHub views use path segments: ${formatResourceUri(ref)}`);
			if (!targetValue.number)
				throw new ResourceError(
					"invalid_path",
					`GitHub collections are listed with find or search, not read: ${formatResourceUri(ref)}`,
				);
			if (targetValue.view) return readGitHubView(ref, kind, targetValue, context, baseCwd);
			assertQuery(ref, []);
			const record = await fetchGitHubItem(kind, targetValue, context, baseCwd);
			const content = renderItem(kind, record);
			return { resource: resourceFor(ref, record, kind, content, "text/markdown"), content };
		},
		async search(request): Promise<SearchHit[]> {
			if (!request.scope || (request.scope.scheme !== "pr" && request.scope.scheme !== "issue")) return [];
			assertQuery(request.scope, ["state", "limit", "author", "label"]);
			const kind = githubKind(request.scope.scheme);
			const targetValue = target(request.scope);
			const limit = collectionLimit(String(request.limit ?? request.scope.query.limit ?? 50));
			const records = await listGitHubItems(
				kind,
				targetValue,
				request.scope.query,
				request.query,
				limit,
				request.context,
				baseCwd,
			);
			return records.map((record) => ({
				...listedResource(request.scope!, record, kind),
				snippet: stringValue(record.title),
				score: 1,
			}));
		},
		async find(ref, context) {
			assertQuery(ref, ["state", "limit", "author", "label"]);
			const kind = githubKind(ref.scheme);
			const targetValue = target(ref);
			const limit = collectionLimit(ref.query.limit, COLLECTION_LIMIT);
			const records = await listGitHubItems(kind, targetValue, ref.query, "", limit, context, baseCwd);
			return records.map((record) => listedResource(ref, record, kind));
		},
		async write(ref, request) {
			if (ref.scheme !== "pr") {
				throw new ResourceError("read_only", `Resource is read-only: ${formatResourceUri(ref)}`);
			}
			return writeThread(ref, request, request.context, baseCwd);
		},
		async capabilities(ref) {
			return githubCapabilities(ref);
		},
	};
}
