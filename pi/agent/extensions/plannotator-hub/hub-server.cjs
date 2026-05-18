#!/usr/bin/env node

const { createServer } = require("node:http");
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const {
	DEFAULT_BIND_HOST,
	DEFAULT_HUB_PORT,
	DEFAULT_PUBLIC_URL,
	buildPublicSessionUrl,
	normalizePublicBaseUrl,
	rewriteHtmlForSession,
	summarizeSession,
	validateBackendUrl,
	newSessionId,
} = require("./shared.cjs");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SECRET_PATH = process.env.PLANNOTATOR_HUB_SECRET_FILE || join(homedir(), ".pi", "plannotator-hub-secret");

function ensureSecret() {
	if (existsSync(SECRET_PATH)) {
		return readFileSync(SECRET_PATH, "utf8").trim();
	}
	mkdirSync(dirname(SECRET_PATH), { recursive: true });
	const secret = randomBytes(24).toString("hex");
	writeFileSync(SECRET_PATH, `${secret}\n`, { mode: 0o600 });
	return secret;
}

function json(res, status, payload) {
	const body = JSON.stringify(payload, null, 2);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function text(res, status, body, headers = {}) {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body),
		...headers,
	});
	res.end(body);
}

function escapeHtml(value) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function requireSecret(req, expected) {
	const raw = req.headers.authorization || "";
	return raw === `Bearer ${expected}`;
}

function removeSession(state, sessionId) {
	const entry = state.sessions.get(sessionId);
	if (!entry) return false;
	state.sessions.delete(sessionId);
	if (state.sessionIdsByBackend.get(entry.backendUrl) === sessionId) {
		state.sessionIdsByBackend.delete(entry.backendUrl);
	}
	return true;
}

function pruneSessions(state) {
	const now = Date.now();
	for (const [id, entry] of state.sessions) {
		if (now - entry.updatedAt > SESSION_TTL_MS) {
			removeSession(state, id);
		}
	}
}

async function isBackendAlive(entry) {
	try {
		const response = await fetch(`${entry.backendUrl}/api/health`, {
			method: "GET",
			cache: "no-store",
			signal: AbortSignal.timeout(1_000),
		});
		return response.ok || response.status === 404;
	} catch {
		return false;
	}
}

async function pruneDeadSessions(state) {
	const entries = [...state.sessions.entries()];
	await Promise.all(
		entries.map(async ([sessionId, entry]) => {
			if (!(await isBackendAlive(entry))) removeSession(state, sessionId);
		}),
	);
}

function renderHubPage() {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plannotator Hub</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b1020; color: #e6edf7; }
    main { max-width: 1080px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { color: #9db0cf; }
    .meta { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 24px; }
    .pill { border: 1px solid #2d3a57; border-radius: 999px; padding: 6px 10px; font-size: 12px; color: #b8c5db; }
    .sessions { display: grid; gap: 12px; }
    .card { background: #121a2b; border: 1px solid #23304d; border-radius: 14px; padding: 16px; display: grid; gap: 10px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .kind { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #75a7ff; }
    .title { font-size: 18px; font-weight: 600; }
    .details { display: grid; gap: 4px; font-size: 13px; color: #9db0cf; }
    a.button { text-decoration: none; background: #4f8cff; color: white; padding: 8px 12px; border-radius: 10px; font-weight: 600; }
    .empty { border: 1px dashed #334160; border-radius: 14px; padding: 24px; color: #9db0cf; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>Plannotator Hub</h1>
    <p>Active Plannotator sessions proxied through one exposed port.</p>
    <div class="meta">
      <div class="pill">Path proxy: <code>/s/&lt;session&gt;/</code></div>
      <div class="pill">Auto-refresh: 5s</div>
    </div>
    <section id="sessions" class="sessions">
      <div class="empty">Waiting for a Plannotator session to register.</div>
    </section>
  </main>
  <script>
    const sessionsNode = document.getElementById("sessions");
    function fmtDate(value) {
      try { return new Date(value).toLocaleString(); } catch { return value; }
    }
    function renderSessions(items) {
      if (!Array.isArray(items) || items.length === 0) {
        sessionsNode.innerHTML = '<div class="empty">Waiting for a Plannotator session to register.</div>';
        return;
      }
      sessionsNode.innerHTML = items.map((item) => {
        const details = [
          item.repoDisplay ? 'Repo: ' + item.repoDisplay : '',
          item.resource ? 'Target: ' + item.resource : '',
          item.cwd ? 'CWD: ' + item.cwd : '',
          item.sessionName ? 'Pi session: ' + item.sessionName : (item.sessionFile ? 'Pi session file: ' + item.sessionFile : ''),
          'Updated: ' + fmtDate(item.updatedAt),
        ].filter(Boolean).map((text) => '<div>' + escapeHtml(text) + '</div>').join('');
        return \`
          <article class="card">
            <div class="row">
              <div>
                <div class="kind">\${escapeHtml(item.kind || "session")}</div>
                <div class="title">\${escapeHtml(item.title || "Untitled")}</div>
              </div>
              <a class="button" href="\${item.url}" target="_blank" rel="noreferrer">Open</a>
            </div>
            <div class="details">\${details}</div>
          </article>\`;
      }).join('');
    }
    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }
    async function refresh() {
      try {
        const response = await fetch('/api/sessions', { cache: 'no-store' });
        const data = await response.json();
        renderSessions(data.sessions || []);
      } catch (error) {
        sessionsNode.innerHTML = '<div class="empty">Failed to load sessions.</div>';
      }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = Buffer.concat(chunks).toString("utf8");
	return body ? JSON.parse(body) : {};
}

function proxyHeaders(reqHeaders) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(reqHeaders)) {
		if (value == null) continue;
		const lower = key.toLowerCase();
		if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}
	return headers;
}

function shouldRewriteHtml(upstream, targetPath) {
	const contentType = upstream.headers.get("content-type") || "";
	return contentType.includes("text/html") || targetPath === "/";
}

async function pipeUpstreamBodyToResponse(body, res) {
	await pipeline(Readable.fromWeb(body), res);
}

async function proxyToBackend(state, req, res, session, targetPath, search) {
	const targetUrl = new URL(`${targetPath}${search}`, `${session.backendUrl}/`);
	const init = {
		method: req.method,
		headers: proxyHeaders(req.headers),
		redirect: "manual",
	};
	if (req.method !== "GET" && req.method !== "HEAD") {
		init.body = Readable.toWeb(req);
		init.duplex = "half";
	}

	const upstream = await fetch(targetUrl, init);
	session.updatedAt = Date.now();

	if (shouldRewriteHtml(upstream, targetPath)) {
		const html = await upstream.text();
		const body = rewriteHtmlForSession(html, session.id);
		const headers = {};
		for (const [key, value] of upstream.headers.entries()) {
			if (["content-length", "content-encoding"].includes(key.toLowerCase())) continue;
			headers[key] = value;
		}
		text(res, upstream.status, body, headers);
		return;
	}

	for (const [key, value] of upstream.headers.entries()) {
		if (key.toLowerCase() === "content-length") continue;
		res.setHeader(key, value);
	}
	res.statusCode = upstream.status;
	if (!upstream.body) {
		res.end();
		return;
	}
	await pipeUpstreamBodyToResponse(upstream.body, res);
}

function createState() {
	return {
		publicBaseUrl: normalizePublicBaseUrl(process.env.PLANNOTATOR_HUB_PUBLIC_URL || DEFAULT_PUBLIC_URL),
		secret: ensureSecret(),
		sessions: new Map(),
		sessionIdsByBackend: new Map(),
	};
}

function upsertSession(state, payload) {
	const existingId = state.sessionIdsByBackend.get(payload.backendUrl);
	const existing = existingId ? state.sessions.get(existingId) : undefined;
	const id = existing?.id || newSessionId();
	const url = buildPublicSessionUrl(state.publicBaseUrl, id);
	const now = Date.now();
	const entry = {
		id,
		url,
		backendUrl: payload.backendUrl,
		kind: payload.kind || existing?.kind || "plan",
		mode: payload.mode || existing?.mode,
		title: payload.title || existing?.title || "Plannotator session",
		repoDisplay: payload.repoDisplay || existing?.repoDisplay,
		resource: payload.resource || existing?.resource,
		sessionId: payload.sessionId || existing?.sessionId,
		sessionName: payload.sessionName || existing?.sessionName,
		sessionFile: payload.sessionFile || existing?.sessionFile,
		cwd: payload.cwd || existing?.cwd,
		createdAt: existing?.createdAt || now,
		updatedAt: now,
	};
	state.sessions.set(id, entry);
	state.sessionIdsByBackend.set(entry.backendUrl, id);
	return entry;
}

async function startServer() {
	const state = createState();
	const hubPort = Number(process.env.PLANNOTATOR_HUB_PORT || DEFAULT_HUB_PORT);
	const bindHost = process.env.PLANNOTATOR_HUB_BIND || DEFAULT_BIND_HOST;
	const server = createServer(async (req, res) => {
		try {
			pruneSessions(state);
			const url = new URL(req.url || "/", "http://127.0.0.1");

			if (url.pathname === "/api/health") {
				json(res, 200, { ok: true });
				return;
			}

			if (url.pathname === "/api/sessions") {
				await pruneDeadSessions(state);
				const sessions = [...state.sessions.values()]
					.sort((left, right) => right.updatedAt - left.updatedAt)
					.map((entry) => summarizeSession(entry));
				json(res, 200, { sessions });
				return;
			}

			if (url.pathname === "/api/register" && req.method === "POST") {
				if (!requireSecret(req, state.secret)) {
					json(res, 401, { error: "Unauthorized" });
					return;
				}
				const payload = await readJson(req);
				const validated = validateBackendUrl(payload.backendUrl, hubPort);
				if (!validated.ok) {
					json(res, 400, { error: validated.reason });
					return;
				}
				const entry = upsertSession(state, { ...payload, backendUrl: validated.url });
				json(res, 200, { id: entry.id, url: entry.url });
				return;
			}

			if (url.pathname === "/api/unregister" && req.method === "POST") {
				if (!requireSecret(req, state.secret)) {
					json(res, 401, { error: "Unauthorized" });
					return;
				}
				const payload = await readJson(req);
				const sessionId = typeof payload?.id === "string" ? payload.id : "";
				if (!sessionId) {
					json(res, 400, { error: "Missing session id" });
					return;
				}
				json(res, 200, { removed: removeSession(state, sessionId) });
				return;
			}

			if (url.pathname === "/") {
				text(res, 200, renderHubPage());
				return;
			}

			const match = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/u);
			if (match) {
				const sessionId = decodeURIComponent(match[1]);
				const targetPath = match[2] || "/";
				const session = state.sessions.get(sessionId);
				if (!session) {
					text(res, 404, "<h1>Unknown Plannotator session</h1>");
					return;
				}
				if (!match[2]) {
					res.writeHead(302, { location: `/s/${encodeURIComponent(sessionId)}/` });
					res.end();
					return;
				}
				if (!(await isBackendAlive(session))) {
					removeSession(state, sessionId);
					text(res, 404, "<h1>Closed Plannotator session</h1>");
					return;
				}
				try {
					await proxyToBackend(state, req, res, session, targetPath, url.search);
				} catch (error) {
					if (error instanceof Error && /(ECONNREFUSED|fetch failed|socket hang up)/i.test(error.message)) {
						removeSession(state, sessionId);
						text(res, 404, "<h1>Closed Plannotator session</h1>");
						return;
					}
					throw error;
				}
				return;
			}

			text(res, 404, "<h1>Not found</h1>");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			text(res, 500, `<h1>Plannotator hub error</h1><pre>${escapeHtml(message)}</pre>`);
		}
	});

	server.listen(hubPort, bindHost, () => {
		const address = state.publicBaseUrl;
		process.stdout.write(`[plannotator-hub] listening on ${bindHost}:${hubPort} (public ${address})\n`);
	});
}

if (require.main === module) {
	startServer().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

module.exports = {
	createState,
	isBackendAlive,
	pipeUpstreamBodyToResponse,
	pruneDeadSessions,
	removeSession,
	renderHubPage,
	startServer,
};
