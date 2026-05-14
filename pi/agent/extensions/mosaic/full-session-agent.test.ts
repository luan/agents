import { describe, expect, test } from "bun:test";
import { buildBootstrapPayload, withMosaicLeaderInstructions } from "./full-session-agent";

describe("buildBootstrapPayload", () => {
	test("includes native message transport bootstrap fields", () => {
		const payload = buildBootstrapPayload({
			agentId: "agent-1",
			agentType: "Explore",
			description: "Review code",
			prompt: "review",
			systemPrompt: "system",
			builtinToolNames: ["read"],
			extensions: true,
			messageEndpoint: "tcp://127.0.0.1:12345",
			messageToken: "token-1",
		});

		expect(payload.messageEndpoint).toBe("tcp://127.0.0.1:12345");
		expect(payload.messageToken).toBe("token-1");
	});

	test("adds explicit leader-channel instructions to native mosaic agents", () => {
		const prompt = withMosaicLeaderInstructions("base system");

		expect(prompt).toContain("message_leader");
		expect(prompt).toContain("ask/tell/contact the leader");
		expect(prompt).toContain("Do not use spawn_lane, spawn_list, or spawn_map");
	});
});
