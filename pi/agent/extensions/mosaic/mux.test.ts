import { describe, expect, test } from "bun:test";
import { shouldPublishMosaicHeartbeat } from "./mux";

describe("mosaic mux heartbeat", () => {
	test("does not publish a heartbeat for idle parent sessions", () => {
		expect(shouldPublishMosaicHeartbeat({})).toBe(false);
	});

	test("publishes a heartbeat for mosaic child agent sessions", () => {
		expect(shouldPublishMosaicHeartbeat({ agentId: "agent-1" })).toBe(true);
	});
});
