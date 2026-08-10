import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

const config = JSON.parse(readFileSync(process.env.PI_ATTACHED_AGENT_CONFIG, "utf8"));
try {
	unlinkSync(process.env.PI_ATTACHED_AGENT_CONFIG);
} catch {}
const clients = new Set();
let currentCtx;
let started = false;
let streaming = false;
let currentTurnId = "initial";
let lastResult;
let readyState;
let responseText = "";
let responseError;

function send(socket, message) {
	socket.write(`${JSON.stringify(message)}\n`);
}

function broadcast(message) {
	for (const socket of clients) send(socket, message);
}

function assistantText(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function publishEvent(event) {
	broadcast({ type: "event", turnId: currentTurnId, event });
}

async function handle(message, pi) {
	if (message.type === "start") return;
	if (message.type === "steer") {
		pi.sendUserMessage(message.message, { deliverAs: "steer" });
		return;
	}
	if (message.type === "prompt") {
		if (streaming) throw new Error("Agent is still running");
		currentTurnId = message.turnId;
		pi.sendUserMessage(message.message);
		return;
	}
	if (message.type === "abort") {
		currentCtx?.abort();
		return;
	}
	if (message.type === "stop") currentCtx?.shutdown();
}

try {
	unlinkSync(config.socketPath);
} catch {}

const server = createServer((socket) => {
	clients.add(socket);
	send(socket, { type: "state", started, streaming, lastResult });
	if (readyState) send(socket, { type: "ready", state: readyState });
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				void handle(JSON.parse(line), extensionApi).catch((error) =>
					send(socket, { type: "error", error: error.message }),
				);
			} catch (error) {
				send(socket, { type: "error", error: `Invalid control message: ${error.message}` });
			}
		}
	});
	socket.on("close", () => clients.delete(socket));
	socket.on("error", () => clients.delete(socket));

});
let bridgeClosed = false;

function shutdownBridge() {
	if (bridgeClosed) return;
	bridgeClosed = true;
	for (const socket of clients) socket.destroy();
	clients.clear();
	if (server.listening) server.close();
	try {
		unlinkSync(config.socketPath);
	} catch {}
}


server.listen(config.socketPath, () => {
	chmodSync(config.socketPath, 0o600);
	broadcast({ type: "bridge_ready" });
});

let extensionApi;

export default function attachedAgentControl(pi) {
	extensionApi = pi;
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		started = true;
		readyState = {
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionId: ctx.sessionManager.getSessionId(),
		};
		broadcast({ type: "ready", state: readyState });
	});
	pi.on("input", (event) => {
		if (event.source === "interactive" && currentTurnId !== "initial") {
			currentTurnId = `terminal-${Date.now()}`;
		}
	});
	pi.on("agent_start", (event) => {
		streaming = true;
		responseText = "";
		responseError = undefined;
		publishEvent({ type: "agent_start", ...event });
	});
	pi.on("message_start", (event) => publishEvent({ type: "message_start", ...event }));
	pi.on("message_update", (event) => {
		if (event.assistantMessageEvent?.type === "text_delta") responseText += event.assistantMessageEvent.delta;
		publishEvent({ type: "message_update", ...event });
	});
	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") {
			responseText = assistantText(event.message) || responseText;
			responseError = event.message.stopReason === "error" ? event.message.errorMessage || "Assistant request failed" : undefined;
		}
		publishEvent({ type: "message_end", ...event });
	});
	pi.on("tool_execution_start", (event) => publishEvent({ type: "tool_execution_start", ...event }));
	pi.on("tool_execution_end", (event) => publishEvent({ type: "tool_execution_end", ...event }));
	pi.on("turn_end", (event) => publishEvent({ type: "turn_end", ...event }));
	pi.on("session_compact", (event) =>
		publishEvent({
			type: "compaction_end",
			aborted: false,
			reason: event.reason,
			result: event.compactionEntry,
		}),
	);
	pi.on("agent_settled", () => {
		streaming = false;
		lastResult = {
			type: "result",
			turnId: currentTurnId,
			responseText,
			error: responseError,
		};
		broadcast(lastResult);
		currentTurnId = undefined;
	});
	pi.on("session_shutdown", () => {
		currentCtx = undefined;
		shutdownBridge();
	});

}

process.on("exit", shutdownBridge);
