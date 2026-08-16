import { runCommand } from "./command-runner.ts";
import type { ResourceContext } from "./resources.ts";

export type GitHubKind = "pr" | "issue";
export type GitHubRecord = Record<string, unknown>;
export type GitHubTarget = {
	repo?: string;
	number?: string;
	view?: string;
	selector?: string;
};

const ITEM_FIELDS: Record<GitHubKind, string> = {
	pr: "number,title,state,isDraft,url,author,body,baseRefName,headRefName,headRefOid,mergedAt,createdAt,updatedAt,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus,labels,assignees,milestone",
	issue: "number,title,state,stateReason,url,author,body,createdAt,updatedAt,labels,assignees,milestone",
};
const VIEW_BASE_FIELDS: Record<GitHubKind, string> = {
	pr: "number,title,state,isDraft,url,author,baseRefName,headRefName,headRefOid,mergedAt,updatedAt,additions,deletions,changedFiles,reviewDecision,mergeable,mergeStateStatus,labels,assignees,milestone",
	issue: "number,title,state,stateReason,url,author,updatedAt,labels,assignees,milestone",
};
const LIST_FIELDS = "number,title,state,url,author,updatedAt";
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title state isDraft url author{login} baseRefName headRefName headRefOid mergedAt updatedAt additions deletions changedFiles reviewDecision mergeable mergeStateStatus reviewThreads(first:100){totalCount nodes{id isResolved path line comments(first:1){totalCount nodes{author{login} bodyText url}}}}}}}`;
const THREAD_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved path line comments(first:100){totalCount nodes{author{login} bodyText diffHunk url}}}}}`;
const REPLY_THREAD_MUTATION = `mutation ReplyToPullRequestReviewThread($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
const RESOLVE_THREAD_MUTATION = `mutation ResolvePullRequestReviewThread($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
const UNRESOLVE_THREAD_MUTATION = `mutation UnresolvePullRequestReviewThread($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;

function parseRecord(text: string): GitHubRecord {
	const value = JSON.parse(text) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("GitHub CLI returned a non-object result");
	return value as GitHubRecord;
}

function parseRecords(text: string): GitHubRecord[] {
	const value = JSON.parse(text) as unknown;
	if (!Array.isArray(value)) throw new Error("GitHub CLI returned a non-array result");
	return value.filter((item): item is GitHubRecord => Boolean(item) && typeof item === "object");
}

async function runGh(
	args: string[],
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
	input?: string,
): Promise<string> {
	const scoped = target.repo ? [...args, "--repo", target.repo] : args;
	const result = await runCommand("gh", scoped, context?.cwd ?? baseCwd, {
		signal: context?.signal,
		input,
	});
	return result.stdout;
}

async function runGhApi(
	args: string[],
	context: ResourceContext | undefined,
	baseCwd: string,
	input?: string,
): Promise<string> {
	const result = await runCommand("gh", args, context?.cwd ?? baseCwd, {
		signal: context?.signal,
		input,
	});
	return result.stdout;
}

function itemNumber(target: GitHubTarget): string {
	if (!target.number) throw new Error("GitHub item number is required");
	return target.number;
}

function listState(kind: GitHubKind, value: string | undefined): string {
	const state = value?.toLowerCase() ?? "open";
	const allowed = kind === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
	if (!allowed.includes(state)) throw new Error(`Unsupported ${kind} state: ${state}`);
	return state;
}

export async function fetchGitHubItem(
	kind: GitHubKind,
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	return parseRecord(
		await runGh([kind, "view", itemNumber(target), "--json", ITEM_FIELDS[kind]], target, context, baseCwd),
	);
}

export async function listGitHubItems(
	kind: GitHubKind,
	target: GitHubTarget,
	query: Record<string, string>,
	search: string,
	limit: number,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord[]> {
	const args = [
		kind,
		"list",
		"--json",
		LIST_FIELDS,
		"--limit",
		String(limit),
		"--state",
		listState(kind, query.state),
	];
	if (query.author) args.push("--author", query.author.replace(/^@/, ""));
	for (const label of (query.label ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)) {
		args.push("--label", label);
	}
	if (search.trim()) args.push("--search", search.trim());
	return parseRecords(await runGh(args, target, context, baseCwd));
}

export async function fetchGitHubComments(
	kind: GitHubKind,
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	return parseRecord(
		await runGh(
			[kind, "view", itemNumber(target), "--json", `${VIEW_BASE_FIELDS[kind]},comments`],
			target,
			context,
			baseCwd,
		),
	);
}

export async function fetchPullRequestFiles(
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	return parseRecord(
		await runGh(
			["pr", "view", itemNumber(target), "--json", `${VIEW_BASE_FIELDS.pr},files`],
			target,
			context,
			baseCwd,
		),
	);
}

export async function fetchPullRequestChecks(
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	return parseRecord(
		await runGh(
			["pr", "view", itemNumber(target), "--json", `${VIEW_BASE_FIELDS.pr},statusCheckRollup`],
			target,
			context,
			baseCwd,
		),
	);
}

export async function resolveGitHubRepository(
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string> {
	if (target.repo) return target.repo;
	const record = parseRecord(await runGhApi(["repo", "view", "--json", "nameWithOwner"], context, baseCwd));
	if (typeof record.nameWithOwner !== "string") throw new Error("GitHub repository has no owner/name");
	return record.nameWithOwner;
}

export async function fetchPullRequestFile(
	target: GitHubTarget,
	path: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord | undefined> {
	const repository = await resolveGitHubRepository(target, context, baseCwd);
	// One page bounds the read. A pull request with more than 100 changed files truncates here.
	const files = parseRecords(
		await runGhApi(["api", `repos/${repository}/pulls/${itemNumber(target)}/files?per_page=100`], context, baseCwd),
	);
	return files.find((file) => file.filename === path);
}

async function graphql(
	query: string,
	variables: Record<string, unknown>,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	const root = parseRecord(
		await runGhApi(["api", "graphql", "--input", "-"], context, baseCwd, JSON.stringify({ query, variables })),
	);
	const errors = root.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		const first = errors.find((error): error is GitHubRecord => Boolean(error) && typeof error === "object");
		throw new Error(`GitHub GraphQL error: ${String(first?.message ?? "unknown error")}`);
	}
	const data = root.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("GitHub GraphQL returned no data");
	return data as GitHubRecord;
}

export async function fetchPullRequestThreads(
	target: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord> {
	const repository = await resolveGitHubRepository(target, context, baseCwd);
	const [owner, name] = repository.split("/", 2);
	return graphql(THREADS_QUERY, { owner, name, number: Number(itemNumber(target)) }, context, baseCwd);
}

export async function fetchPullRequestThread(
	id: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GitHubRecord | undefined> {
	const data = await graphql(THREAD_QUERY, { id }, context, baseCwd);
	return data.node && typeof data.node === "object" && !Array.isArray(data.node)
		? (data.node as GitHubRecord)
		: undefined;
}

export async function replyToPullRequestThread(
	threadId: string,
	body: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<void> {
	await graphql(REPLY_THREAD_MUTATION, { threadId, body }, context, baseCwd);
}

export async function setPullRequestThreadResolved(
	threadId: string,
	resolved: boolean,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<void> {
	await graphql(resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION, { threadId }, context, baseCwd);
}
