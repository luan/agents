import { expect, test } from "bun:test";
import { stripTopLevelZoneMarkers } from "../src/terminal/embedding.ts";

test("removes transcript zones embedded after another column", () => {
	expect(
		stripTopLevelZoneMarkers(["agent │ \x1b]133;A\x07\x1b[48;2;40;46;68mmessage\x1b]133;B\x1b\\\x1b]133;C\x07"]),
	).toEqual(["agent │ \x1b[48;2;40;46;68mmessage"]);
});

test("preserves renderer styling and content", () => {
	expect(stripTopLevelZoneMarkers(["\x1b[32mtool output\x1b[0m"])).toEqual(["\x1b[32mtool output\x1b[0m"]);
});
