import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_INTERVAL = "10m";
const MIN_INTERVAL_MS = 10_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FIRES = 500;

const USAGE = `Usage: /loop [interval] <prompt>

Intervals: Ns, Nm, Nh, Nd. Examples:
  /loop 5m /review
  /loop 30m check the deploy
  /loop check the deploy every 20m
  /loop list
  /loop stop [id]`;

type LoopEntry = {
	id: string;
	prompt: string;
	intervalMs: number;
	createdAt: number;
	fireCount: number;
	maxFires: number;
	timer: ReturnType<typeof setInterval>;
	expiryTimer: ReturnType<typeof setTimeout>;
};

type ParseResult = {
	intervalMs: number;
	prompt: string;
};

const loops = new Map<string, LoopEntry>();
let nextId = 1;

function parseInterval(token: string): number | undefined {
	const match = token.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
	if (!match) return undefined;
	const value = Number.parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	if (unit === "s") return value * 1_000;
	if (unit === "m") return value * 60_000;
	if (unit === "h") return value * 3_600_000;
	return value * 86_400_000;
}

function formatInterval(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

function parseArgs(input: string): ParseResult | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;

	const [first = "", ...rest] = trimmed.split(/\s+/);
	const leading = parseInterval(first);
	if (leading !== undefined) return { intervalMs: leading, prompt: rest.join(" ").trim() };

	const trailing = trimmed.match(/^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)(s|m|h|d|seconds?|minutes?|hours?|days?)$/i);
	if (trailing) {
		const unitWord = trailing[3].toLowerCase();
		const unit = unitWord[0] as "s" | "m" | "h" | "d";
		return {
			intervalMs: parseInterval(`${trailing[2]}${unit}`)!,
			prompt: trailing[1].trim(),
		};
	}

	return { intervalMs: parseInterval(DEFAULT_INTERVAL)!, prompt: trimmed };
}

function cancel(entry: LoopEntry) {
	clearInterval(entry.timer);
	clearTimeout(entry.expiryTimer);
	loops.delete(entry.id);
}

function cancelAll(): number {
	const count = loops.size;
	for (const loop of loops.values()) cancel(loop);
	return count;
}

export default function loopExtension(pi: ExtensionAPI) {
	pi.registerCommand("loop", {
		description: `Run a prompt or slash command repeatedly (default ${DEFAULT_INTERVAL})`,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "help") return ctx.ui.notify(USAGE, "info");

			if (trimmed === "list") {
				if (loops.size === 0) return ctx.ui.notify("No active loops.", "info");
				const lines = [...loops.values()].map(
					(loop) =>
						`• ${loop.id} every ${formatInterval(loop.intervalMs)} fires ${loop.fireCount}/${loop.maxFires}: ${loop.prompt}`,
				);
				return ctx.ui.notify(`Active loops:\n${lines.join("\n")}`, "info");
			}

			if (trimmed === "stop") {
				const count = cancelAll();
				return ctx.ui.notify(count === 0 ? "No active loops." : `Cancelled ${count} loop(s).`, "info");
			}

			if (trimmed.startsWith("stop ")) {
				const id = trimmed.slice(5).trim();
				const entry = loops.get(id);
				if (!entry) return ctx.ui.notify(`No loop found with id ${id}.`, "warning");
				cancel(entry);
				return ctx.ui.notify(`Cancelled ${id}.`, "info");
			}

			const parsed = parseArgs(trimmed);
			if (!parsed?.prompt) return ctx.ui.notify(USAGE, "warning");

			const intervalMs = Math.max(parsed.intervalMs, MIN_INTERVAL_MS);
			const id = `loop-${nextId++}`;

			const sendPrompt = () => {
				const entry = loops.get(id);
				if (!entry) return;
				entry.fireCount += 1;
				if (entry.fireCount > entry.maxFires) {
					cancel(entry);
					ctx.ui.notify(`Loop ${id} stopped after ${entry.maxFires} fires.`, "info");
					return;
				}
				pi.sendUserMessage(parsed.prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			};

			const entry: LoopEntry = {
				id,
				prompt: parsed.prompt,
				intervalMs,
				createdAt: Date.now(),
				fireCount: 0,
				maxFires: DEFAULT_MAX_FIRES,
				timer: setInterval(sendPrompt, intervalMs),
				expiryTimer: setTimeout(() => {
					const current = loops.get(id);
					if (!current) return;
					cancel(current);
					ctx.ui.notify(`Loop ${id} expired after ${formatInterval(MAX_AGE_MS)}.`, "info");
				}, MAX_AGE_MS),
			};
			loops.set(id, entry);

			ctx.ui.notify(`Scheduled ${id}: every ${formatInterval(intervalMs)} — stop with /loop stop ${id}`, "info");
			sendPrompt();
		},
	});

	(pi.on as any)("session_shutdown", () => cancelAll());
}
