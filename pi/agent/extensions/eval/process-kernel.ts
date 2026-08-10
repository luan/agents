import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface KernelResponse {
	id: number;
	output: string;
	error?: string;
}

interface PendingRequest {
	resolve: (response: KernelResponse) => void;
	reject: (error: Error) => void;
}

export interface ProcessKernelOptions {
	command: string;
	args: string[];
	label: string;
}

export class ProcessKernel {
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private stderr = "";

	constructor(private readonly options: ProcessKernelOptions) {}

	reset(): void {
		this.stop(new Error(`${this.options.label} kernel reset`));
	}

	execute(code: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<KernelResponse> {
		const child = this.ensureProcess();
		const id = this.nextId++;
		return new Promise<KernelResponse>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				callback();
			};
			const abort = () => this.stop(new Error("eval aborted"));
			const timer = setTimeout(
				() => this.stop(new Error(`eval timed out after ${timeoutSeconds}s`)),
				timeoutSeconds * 1000,
			);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (response) => finish(() => resolve(response)),
				reject: (error) => finish(() => reject(error)),
			});
			signal?.addEventListener("abort", abort, { once: true });
			child.stdin.write(`${JSON.stringify({ id, code, cwd })}\n`, (error) => {
				if (error) this.stop(error);
			});
		});
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;
		this.stderr = "";
		const child = spawn(this.options.command, this.options.args, {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: { ...process.env, NO_COLOR: "1" },
		}) as ChildProcessWithoutNullStreams;
		this.child = child;
		createInterface({ input: child.stdout }).on("line", (line) => {
			let response: KernelResponse;
			try {
				response = JSON.parse(line) as KernelResponse;
			} catch {
				this.stop(new Error(`${this.options.label} kernel protocol error: ${line}`));
				return;
			}
			this.pending.get(response.id)?.resolve(response);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
		});
		child.on("error", (error) => {
			if (this.child === child) this.stop(error);
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			const detail = this.stderr.trim();
			const suffix = detail ? `: ${detail}` : "";
			this.stop(new Error(`${this.options.label} kernel exited (${signal ?? code ?? "unknown"})${suffix}`));
		});
		return child;
	}

	private stop(error: Error, kill = true): void {
		const child = this.child;
		this.child = undefined;
		if (child && kill) {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else {
				child.kill("SIGKILL");
			}
		}
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) request.reject(error);
	}
}
