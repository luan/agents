import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const child = spawn(process.execPath, [config.cliPath, ...config.args, config.prompt], {
	cwd: config.cwd,
	env: {
		...process.env,
		PI_ATTACHED_AGENT: "1",
		PI_SUBAGENT_NAME: config.agentName,
		PI_ATTACHED_AGENT_CONFIG: configPath,
		...(config.modelRole ? { PI_ATTACHED_AGENT_MODEL_ROLE: config.modelRole } : {}),
	},
	stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
child.once("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
