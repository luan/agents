import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type AgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import xsettings from "../src/extension.ts";
import { ensureXSettingsRegistry } from "../src/protocol/settings.ts";

const reasons: SessionShutdownEvent["reason"][] = ["quit", "reload", "new", "resume", "fork"];

test.each(reasons)("disposes the settings host on RPC session shutdown (%s)", async (reason) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-lifecycle-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	let session: AgentSession | undefined;
	let stopped = false;
	try {
		const models = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(directory, "models.json"),
			refreshOnCreate: false,
		});
		const settingsManager = SettingsManager.create(directory, directory, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [xsettings],
		});
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			modelRuntime: models,
			resourceLoader,
			sessionManager: SessionManager.inMemory(directory),
		}));
		const errors: string[] = [];
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
		expect(ensureXSettingsRegistry().registrations["pi-xsettings"]).toBeDefined();
		await session.extensionRunner?.emit({ type: "session_shutdown", reason });
		stopped = true;
		session.dispose();
		expect(ensureXSettingsRegistry().registrations["pi-xsettings"]).toBeUndefined();
		expect(ensureXSettingsRegistry().registrations["pi-libtui"]).toBeUndefined();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(errors).toEqual([]);
	} finally {
		if (!stopped) await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
