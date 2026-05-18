const { basename } = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_HUB_PORT = 19432;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_PUBLIC_URL = `http://${DEFAULT_BIND_HOST}:${DEFAULT_HUB_PORT}`;

function ensureTrailingSlash(value) {
	return value.endsWith("/") ? value : `${value}/`;
}

function truncateLabel(value, max = 96) {
	const trimmed = String(value || "").replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function stripMarkdown(value) {
	return String(value || "")
		.replace(/^\s{0,3}(#{1,6}|\*|-|\d+\.)\s+/u, "")
		.replace(/[`*_~[\]]/gu, "")
		.replace(/\((https?:\/\/[^)]+)\)/gu, "$1")
		.trim();
}

function firstMeaningfulLine(text) {
	const lines = String(text || "").split(/\r?\n/u);
	for (const line of lines) {
		const cleaned = stripMarkdown(line);
		if (cleaned) return cleaned;
	}
	return "";
}

function extractPlanTitle(plan) {
	const lines = String(plan || "").split(/\r?\n/u);
	for (const line of lines) {
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/u);
		if (heading?.[1]) return truncateLabel(stripMarkdown(heading[1]));
	}
	for (const line of lines) {
		const checklist = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/u);
		if (checklist?.[1]) return truncateLabel(stripMarkdown(checklist[1]));
	}
	return truncateLabel(firstMeaningfulLine(plan) || "Plan review");
}

function extractDiffTitle(rawPatch, gitRef) {
	if (gitRef) return truncateLabel(gitRef);
	const match = String(rawPatch || "").match(/^diff --git a\/(.+?) b\/(.+)$/mu);
	if (match?.[2]) return truncateLabel(`Review ${match[2]}`);
	return "Code review";
}

function normalizeKind(mode) {
	if (typeof mode !== "string") return "plan";
	if (mode.startsWith("annotate")) return "annotate";
	if (mode === "archive") return "archive";
	return "plan";
}

function describePlanPayload(data) {
	const kind = normalizeKind(data?.mode);
	return {
		kind,
		mode: typeof data?.mode === "string" ? data.mode : undefined,
		title: truncateLabel(
			stripMarkdown(data?.filePath ? basename(data.filePath) : "") ||
				extractPlanTitle(data?.plan || ""),
		),
		resource: typeof data?.filePath === "string" ? data.filePath : data?.projectRoot,
		repoDisplay: data?.repoInfo?.display,
	};
}

function describeReviewPayload(data) {
	return {
		kind: "review",
		mode: typeof data?.diffType === "string" ? data.diffType : undefined,
		title: extractDiffTitle(data?.rawPatch || "", data?.gitRef),
		resource: data?.agentCwd || data?.gitContext?.cwd,
		repoDisplay: data?.repoInfo?.display,
	};
}

function normalizePublicBaseUrl(value) {
	const raw = value || DEFAULT_PUBLIC_URL;
	const url = new URL(ensureTrailingSlash(raw));
	url.hash = "";
	url.search = "";
	return url.toString();
}

function hubLocalBaseUrl(env = process.env) {
	const host = env.PLANNOTATOR_HUB_BIND || DEFAULT_BIND_HOST;
	const port = env.PLANNOTATOR_HUB_PORT || String(DEFAULT_HUB_PORT);
	const resolvedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	return `http://${resolvedHost}:${port}`;
}

function buildPublicSessionUrl(publicBaseUrl, sessionId) {
	return new URL(`s/${encodeURIComponent(sessionId)}/`, normalizePublicBaseUrl(publicBaseUrl)).toString();
}

function validateBackendUrl(rawUrl, hubPort = DEFAULT_HUB_PORT) {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== "http:") {
			return { ok: false, reason: "backend URL must use http" };
		}
		const hostname = parsed.hostname.toLowerCase();
		if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
			return { ok: false, reason: "backend URL must point at localhost" };
		}
		const port = Number(parsed.port || "80");
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return { ok: false, reason: "backend URL port is invalid" };
		}
		if (port === hubPort) {
			return { ok: false, reason: "backend URL points at the hub port" };
		}
		return {
			ok: true,
			url: `${parsed.protocol}//${parsed.hostname}:${port}`,
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function rewriteHtmlForSession(html, sessionId) {
	const prefix = `/s/${encodeURIComponent(sessionId)}`;
	return String(html)
		.replaceAll('"/api/', `"${prefix}/api/`)
		.replaceAll("'/api/", `'${prefix}/api/`)
		.replaceAll("`/api/", `\`${prefix}/api/`)
		.replaceAll('"/favicon.svg"', `"${prefix}/favicon.svg"`)
		.replaceAll("'/favicon.svg'", `'${prefix}/favicon.svg'`)
		.replaceAll("`/favicon.svg`", `\`${prefix}/favicon.svg\``);
}

function summarizeSession(entry) {
	return {
		id: entry.id,
		backendUrl: entry.backendUrl,
		kind: entry.kind,
		mode: entry.mode,
		title: entry.title,
		repoDisplay: entry.repoDisplay,
		resource: entry.resource,
		sessionId: entry.sessionId,
		sessionName: entry.sessionName,
		sessionFile: entry.sessionFile,
		cwd: entry.cwd,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		url: entry.url,
	};
}

function newSessionId() {
	return randomUUID();
}

module.exports = {
	DEFAULT_BIND_HOST,
	DEFAULT_HUB_PORT,
	DEFAULT_PUBLIC_URL,
	buildPublicSessionUrl,
	describePlanPayload,
	describeReviewPayload,
	extractPlanTitle,
	hubLocalBaseUrl,
	newSessionId,
	normalizePublicBaseUrl,
	rewriteHtmlForSession,
	summarizeSession,
	truncateLabel,
	validateBackendUrl,
};
