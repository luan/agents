import { expect, test } from "bun:test";
import { GenerationRateStats } from "./generation-rate";

test("uses finalized output usage over message generation time", () => {
	const stats = new GenerationRateStats();
	stats.startMessage(1000);
	stats.finishMessage(200, 3000);
	stats.finishTurn();
	expect(stats.snapshot()).toEqual({ lastTurnTps: 100, overallTps: 100 });
});

test("excludes response-header and time-to-first-token delay", () => {
	const stats = new GenerationRateStats();
	stats.startMessage(1000);
	stats.markFirstToken(3000);
	stats.finishMessage(200, 5000);
	stats.finishTurn();
	expect(stats.snapshot().lastTurnTps).toBe(100);
});

test("retains last-turn TPS and computes cumulative TPS from summed generation time", () => {
	const stats = new GenerationRateStats();
	stats.startMessage(0);
	stats.finishMessage(100, 1000);
	stats.finishTurn();
	stats.startMessage(10_000);
	stats.finishMessage(100, 13_000);
	stats.finishTurn();
	expect(stats.snapshot().lastTurnTps).toBeCloseTo(33.333, 2);
	expect(stats.snapshot().overallTps).toBe(50);
});

test("idle time between messages does not affect cumulative TPS", () => {
	const stats = new GenerationRateStats();
	stats.startMessage(0);
	stats.finishMessage(100, 1000);
	stats.finishTurn();
	stats.startMessage(1_000_000);
	stats.finishMessage(100, 1_001_000);
	stats.finishTurn();
	expect(stats.snapshot().overallTps).toBe(100);
});
