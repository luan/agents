import { describe, expect, test } from "bun:test";
import { isMosaicOrchestrationToolName } from "./orchestration-tools";

describe("mosaic orchestration tool filtering", () => {
	test("blocks recursive orchestration and skill tools inside subagents", () => {
		expect(isMosaicOrchestrationToolName("spawn_agent")).toBe(true);
		expect(isMosaicOrchestrationToolName("send_message")).toBe(true);
		expect(isMosaicOrchestrationToolName("followup_task")).toBe(true);
		expect(isMosaicOrchestrationToolName("wait_agent")).toBe(true);
		expect(isMosaicOrchestrationToolName("list_agents")).toBe(true);
		expect(isMosaicOrchestrationToolName("close_agent")).toBe(true);
		expect(isMosaicOrchestrationToolName("spawn_lane")).toBe(true);
		expect(isMosaicOrchestrationToolName("spawn_list")).toBe(true);
		expect(isMosaicOrchestrationToolName("spawn_map")).toBe(true);
		expect(isMosaicOrchestrationToolName("skill")).toBe(true);
		expect(isMosaicOrchestrationToolName("read")).toBe(false);
	});
});
