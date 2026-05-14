import { describe, expect, test } from "bun:test";
import { isMosaicOrchestrationToolName } from "./orchestration-tools";

describe("mosaic orchestration tool filtering", () => {
	test("blocks recursive orchestration and skill tools inside subagents", () => {
		expect(isMosaicOrchestrationToolName("Agent")).toBe(true);
		expect(isMosaicOrchestrationToolName("get_subagent_result")).toBe(true);
		expect(isMosaicOrchestrationToolName("steer_subagent")).toBe(true);
		expect(isMosaicOrchestrationToolName("skill")).toBe(true);
		expect(isMosaicOrchestrationToolName("read")).toBe(false);
	});
});
