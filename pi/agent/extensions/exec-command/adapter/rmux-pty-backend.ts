import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { Rmux, type Session } from "../vendor/rmux-sdk/src/index.js";
import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./pty-backend.js";

const RMUX_CONFIG = [
	'set-option -g default-terminal "$TERM"',
	"set-option -g escape-time 0",
	"set-option -g set-clipboard on",
	"set-option -g extended-keys on",
	"set-option -g extended-keys-format xterm",
	"set-option -g allow-passthrough on",
	"set-option -g status off",
	"set-option -g prefix None",
	"set-option -g prefix2 None",
	"set-option -g mouse off",
	'set-option -g terminal-features "$TERM:clipboard:ccolour:cstyle:focus:title:extkeys"',
	"set-option -g base-index 0",
	"set-window-option -g pane-base-index 0",
	"unbind-key -a",
	"unbind-key -a -T root",
	"bind-key -n C-] detach-client",
	"bind-key -n M-BSpace send-keys -l \\033\\177",
	"",
].join("\n");

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
	return join(homedir(), ".pi", "rmux", "exec.sock");
}

function defaultConfigPath(): string {
	return join(homedir(), ".pi", "rmux", "exec.conf");
}

class RmuxPtyProcess implements PtyProcess {
	readonly name: string;
	readonly attachCommand: string;
	readonly attachment: { command: string; args: string[] };
	readonly #server: Rmux;
	readonly #session: Session;
	readonly #streamProcess: ChildProcessByStdio<null, Readable, Readable>;
	readonly #paneTarget: string;
	readonly #dataListeners = new Set<(data: string) => void>();
	readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();
	readonly #pendingData: string[] = [];
	#exitCode: number | undefined;

	constructor(
		server: Rmux,
		session: Session,
		paneTarget: string,
		streamProcess: ChildProcessByStdio<null, Readable, Readable>,
		command: string,
		attachment: { command: string; args: string[] },
	) {
		this.name = session.name;
		this.attachCommand = command;
		this.attachment = attachment;
		this.#server = server;
		this.#session = session;
		this.#paneTarget = paneTarget;
		this.#streamProcess = streamProcess;
		streamProcess.stdout.on("data", (chunk: Buffer) => this.#emitData(chunk.toString("utf8")));
		streamProcess.stderr.on("data", (chunk: Buffer) => this.#emitData(chunk.toString("utf8")));
		streamProcess.once("error", (error) => {
			this.#emitData(`${error.message}\n`);
			this.#finish(1);
		});
		streamProcess.once("close", (code) => void this.#finishFromStream(code ?? 1));
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

	async #finishFromStream(fallbackExitCode: number): Promise<void> {
		if (this.#exitCode !== undefined) return;
		let exitCode = fallbackExitCode;
		try {
			const run = await this.#server.cmd(
				"display-message",
				"-p",
				"-t",
				this.#paneTarget,
				"#{pane_dead}:#{pane_dead_status}",
			);
			if (run.returnCode === 0) {
				const [, status] = run.stdout.trim().split(":", 2);
				const parsed = Number.parseInt(status ?? "", 10);
				if (Number.isInteger(parsed) && parsed >= 0) exitCode = parsed;
			}
		} catch {}
		this.#finish(exitCode);
	}

	#emitData(data: string): void {
		if (this.#dataListeners.size === 0) this.#pendingData.push(data);
		else for (const listener of this.#dataListeners) listener(data);
	}

	#finish(exitCode: number): void {
		if (this.#exitCode !== undefined) return;
		this.#exitCode = exitCode;
		if (this.#streamProcess.exitCode === null && this.#streamProcess.signalCode === null) {
			this.#streamProcess.kill();
		}
		void this.#session.kill().catch(() => undefined);
		for (const listener of this.#exitListeners) listener({ exitCode });
	}
}

function generatedSessionName(): string {
	return `pi-exec-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function isolatedSessionName(requested: string | undefined): string {
	return requested ? `${requested}-${process.pid}-${randomBytes(4).toString("hex")}` : generatedSessionName();
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
			let streamProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
			try {
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
				streamProcess = spawn(
					binary,
					["-f", configFile, "-S", socketPath, "stream-pane", "--raw", "-t", paneTarget],
					{ cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["ignore", "pipe", "pipe"] },
				);
				streamProcess.on("error", () => undefined);
				const command: Array<string | number> = ["respawn-pane", "-k", "-c", spawnOptions.cwd];
				for (const [key, value] of Object.entries(spawnOptions.env)) {
					if (value !== undefined) command.push("-e", `${key}=${value}`);
				}
				command.push("-t", paneTarget, file, ...args);
				await server.cmd(...command, { check: true });
				return new RmuxPtyProcess(
					server,
					session,
					paneTarget,
					streamProcess,
					attachCommand(binary, configFile, socketPath, session.name),
					{ command: binary, args: attachArgs(configFile, socketPath, session.name) },
				);
			} catch (error) {
				streamProcess?.kill();
				await session.kill().catch(() => undefined);
				throw error;
			}
		},
	};
}
