import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

const nodePtyDir = dirname(dirname(fileURLToPath(import.meta.resolve("node-pty"))));
chmodSync(join(nodePtyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), 0o755);

const [shell, ...args] = process.argv.slice(2);
if (!shell) throw new Error("missing shell");

const child = pty.spawn(shell, args, {
	cwd: process.cwd(),
	env: process.env,
	name: process.env.TERM || "xterm-256color",
	cols: 80,
	rows: 24,
});

process.stdin.on("data", (data) => child.write(data.toString()));
child.onData((data) => process.stdout.write(data));
child.onExit(({ exitCode }) => process.exit(exitCode));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
