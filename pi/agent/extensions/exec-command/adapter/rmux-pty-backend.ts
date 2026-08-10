import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type PaneOutputStream, Rmux, type Session } from "../vendor/rmux-sdk/src/index.js";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./pty-backend.js";

const EXIT_POLL_MS = 100;
const RMUX_CONFIG = [
	"set-option -g status off",
	"set-option -g prefix None",
	"set-option -g prefix2 None",
	"set-option -g mouse off",
	"set-option -g base-index 0",
	"set-window-option -g pane-base-index 0",
	"unbind-key -a",
	"unbind-key -a -T root",
	"bind-key -n C-] detach-client",
	"",
].join("\n");

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function generatedSessionName(): string {
	return `pi-exec-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function isolatedSessionName(requested: string | undefined): string {
	return requested ? `${requested}-${process.pid}-${randomBytes(4).toString("hex")}` : generatedSessionName();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function attachCommand(binary: string, configFile: string, socketPath: string, name: string): string {
	return [binary, "-f", configFile, "-S", socketPath, "attach-session", "-t", name].map(shellQuote).join(" ");
}

function attachArgs(configFile: string, socketPath: string, name: string): string[] {
	return ["-f", configFile, "-S", socketPath, "attach-session", "-t", name];
}
function defaultSocketPath(): string {
	return join(homedir(), ".pi", "agent", "rmux", "exec.sock");
}

function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", "rmux", "exec.conf");
}

class RmuxPtyProcess implements PtyProcess {
	readonly name: string;
	readonly attachCommand: string;
	readonly attachment: { command: string; args: string[] };
	readonly #server: Rmux;
	readonly #session: Session;
	readonly #paneTarget: string;
	readonly #stream: PaneOutputStream;
	readonly #dataListeners = new Set<(data: string) => void>();
	readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();
	readonly #pendingData: string[] = [];
	#exitCode: number | undefined;

	constructor(
		server: Rmux,
		session: Session,
		paneTarget: string,
		stream: PaneOutputStream,
		command: string,
		attachment: { command: string; args: string[] },
	) {
		this.name = session.name;
		this.attachCommand = command;
		this.attachment = attachment;
		this.#server = server;
		this.#session = session;
		this.#paneTarget = paneTarget;
		this.#stream = stream;
		void this.#pumpOutput();
		void this.#watchExit();
	}

	async write(data: string): Promise<void> {
		await this.#server.sendText(this.#paneTarget, data);
	}

	async resize(cols: number, rows: number): Promise<void> {
		await this.#server.cmd("resize-pane", "-t", this.#paneTarget, "-x", cols, "-y", rows, { check: true });
	}

	kill(): void {
		if (this.#exitCode !== undefined) return;
		this.#finish(0);
	}

	onData(listener: (data: string) => void): void {
		this.#dataListeners.add(listener);
		for (const data of this.#pendingData.splice(0)) listener(data);
	}

	onExit(listener: (event: { exitCode: number }) => void): void {
		this.#exitListeners.add(listener);
		if (this.#exitCode !== undefined) queueMicrotask(() => listener({ exitCode: this.#exitCode ?? 0 }));
	}

	async #pumpOutput(): Promise<void> {
		try {
			while (this.#exitCode === undefined) {
				const chunk = await this.#stream.next();
				const data = chunk.data.toString("utf8");
				if (this.#dataListeners.size === 0) this.#pendingData.push(data);
				else for (const listener of this.#dataListeners) listener(data);
			}
		} catch (error) {
			if (this.#exitCode !== undefined) return;
			const message = error instanceof Error ? error.message : String(error);
			for (const listener of this.#dataListeners) listener(`${message}\n`);
			this.#finish(1);
		}
	}

	async #watchExit(): Promise<void> {
		while (this.#exitCode === undefined) {
			const run = await this.#server.cmd(
				"display-message",
				"-p",
				"-t",
				this.#paneTarget,
				"#{pane_dead}:#{pane_dead_status}",
			);
			if (run.returnCode === 0) {
				const [dead, status] = run.stdout.trim().split(":", 2);
				if (dead === "1" || dead === "true") {
					this.#finish(Number.parseInt(status ?? "0", 10) || 0);
					return;
				}
			}
			if (run.returnCode !== 0) {
				const message = run.stderr.trim() || `RMUX pane ${this.#paneTarget} is unavailable`;
				if (this.#dataListeners.size === 0) this.#pendingData.push(`${message}\n`);
				else for (const listener of this.#dataListeners) listener(`${message}\n`);
				this.#finish(1);
				return;
			}
			await delay(EXIT_POLL_MS);
		}
	}

	#finish(exitCode: number): void {
		if (this.#exitCode !== undefined) return;
		this.#exitCode = exitCode;
		void this.#stream.close().catch(() => undefined);
		void this.#session.kill().catch(() => undefined);
		for (const listener of this.#exitListeners) listener({ exitCode });
	}
}

export function resolveRmuxBinary(): string | undefined {
	const binary = process.env.RMUX_BIN?.trim() || "rmux";
	const result = spawnSync(binary, ["-V"], { stdio: "ignore" });
	return result.status === 0 ? binary : undefined;
}

export interface RmuxPtyBackendOptions {
	binary?: string;
	socketPath?: string;
	configFile?: string;
}

export function createRmuxPtyBackend(options: RmuxPtyBackendOptions = {}): PtyBackend {
	const socketPath = options.socketPath ?? defaultSocketPath();
	const configFile = options.configFile ?? defaultConfigPath();
	const binary = options.binary ?? "rmux";
	mkdirSync(dirname(socketPath), { recursive: true });
	mkdirSync(dirname(configFile), { recursive: true });
	writeFileSync(configFile, RMUX_CONFIG);
	const server = new Rmux({
		binary: options.binary,
		socketPath,
		configFile,
	});

	return {
		async spawn(file: string, args: string[], spawnOptions: PtySpawnOptions): Promise<PtyProcess> {
			const session = await server.ensureSession(isolatedSessionName(spawnOptions.sessionName), {
				shellCommand: "cat",
			});
			await server.cmd("set-option", "-g", "base-index", "0", { check: true });
			await server.cmd("set-window-option", "-g", "pane-base-index", "0", { check: true });
			await server.cmd("set-option", "-g", "status", "off", { check: true });
			await server.cmd("set-option", "-g", "prefix", "None", { check: true });
			await server.cmd("set-option", "-g", "prefix2", "None", { check: true });
			await server.cmd("set-option", "-g", "mouse", "off", { check: true });
			await server.cmd("unbind-key", "-a", { check: true });
			await server.cmd("unbind-key", "-a", "-T", "root", { check: true });
			await server.cmd("bind-key", "-n", "C-]", "detach-client", { check: true });
			const pane = session.pane(0, 0);
			const paneTarget = await pane.id();
			await server.cmd("set-option", "-t", paneTarget, "remain-on-exit", "on", { check: true });
			await server.cmd("resize-pane", "-t", paneTarget, "-x", spawnOptions.cols, "-y", spawnOptions.rows, {
				check: true,
			});
			const stream = await pane.outputStream();
			const command: Array<string | number> = ["respawn-pane", "-k", "-c", spawnOptions.cwd];
			for (const [key, value] of Object.entries(spawnOptions.env)) {
				if (value !== undefined) command.push("-e", `${key}=${value}`);
			}
			command.push("-t", paneTarget, file, ...args);
			try {
				await server.cmd(...command, { check: true });
			} catch (error) {
				await stream.close().catch(() => undefined);
				await session.kill().catch(() => undefined);
				throw error;
			}
			return new RmuxPtyProcess(
				server,
				session,
				paneTarget,
				stream,
				attachCommand(binary, configFile, socketPath, session.name),
				{ command: binary, args: attachArgs(configFile, socketPath, session.name) },
			);
		},
	};
}
