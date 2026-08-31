import { describe, expect, test } from "bun:test";
import { DEFAULT_CUSTOM_EDITOR_SETTINGS } from "../src/config/settings.ts";
import { EDITOR_PRESETS, PROMPT_MARKERS, resolveEditorComposition } from "../src/core/composition.ts";

describe("custom editor compositions", () => {
	test("offers only the selected static prompt markers", () => {
		expect(Object.values(PROMPT_MARKERS)).toEqual([
			[],
			["⟩"],
			["⟫"],
			["⮞"],
			["▶"],
			["▷"],
			["⨠"],
			["⪼"],
			["❩"],
			["❫"],
			["❭"],
			["❯"],
			["❱"],
			[""],
			[""],
			[""],
			[""],
			["󰔰"],
		]);
		expect(Object.values(PROMPT_MARKERS).every((frames) => frames.length <= 1)).toBe(true);
	});

	test("keeps presets declarative and independently composed", () => {
		expect(EDITOR_PRESETS["claude-code"]).toMatchObject({
			top: "rule",
			bottom: "rule",
			bottomStatus: false,
			topLeftSegments: ["path", "git", "context"],
		});
		expect(EDITOR_PRESETS.pi).toMatchObject({ top: "rule", bottom: "rule", bottomStatus: true });
		expect(EDITOR_PRESETS.borderless).toMatchObject({
			top: "none",
			bottom: "none",
			surface: "transparent",
			topLeftSegments: [],
			topRightSegments: [],
		});
	});

	test("applies explicit controls over a preset without changing unrelated pieces", () => {
		const resolved = resolveEditorComposition({
			...DEFAULT_CUSTOM_EDITOR_SETTINGS,
			preset: "borderless",
			leftRail: "animated",
			rightRail: "static",
			promptMarker: "triangleFilled",
			segmentSource: "custom",
			topLeftSegments: ["model", "git"],
			topRightSegments: ["context-window"],
			bottomLeftSegments: ["role"],
			bottomRightSegments: ["context"],
			workingPlacement: "top-left-start",
		});

		expect(resolved.style).toMatchObject({
			surface: "transparent",
			leftRail: "animated",
			rightRail: "static",
			promptMarker: ["▶"],
			promptMarkerMotion: "static",
		});
		expect(resolved.topLeftSegments).toEqual(["working", "model", "git"]);
		expect(resolved.topRightSegments).toEqual(["context-window"]);
		expect(resolved.bottomLeftSegments).toEqual(["role"]);
		expect(resolved.bottomRightSegments).toEqual(["context"]);
	});

	test("defaults working activity to Pi's transcript and places it in one requested quadrant", () => {
		const transcript = resolveEditorComposition(DEFAULT_CUSTOM_EDITOR_SETTINGS);
		expect(DEFAULT_CUSTOM_EDITOR_SETTINGS.workingPlacement).toBe("transcript");
		expect([
			...transcript.topLeftSegments,
			...transcript.topRightSegments,
			...transcript.bottomLeftSegments,
			...transcript.bottomRightSegments,
		]).not.toContain("working");

		const resolved = resolveEditorComposition({
			...DEFAULT_CUSTOM_EDITOR_SETTINGS,
			preset: "claude-code",
			segmentSource: "custom",
			topLeftSegments: ["working", "path"],
			topRightSegments: ["working", "model"],
			bottomLeftSegments: ["working", "elapsed"],
			bottomRightSegments: ["context", "working"],
			workingPlacement: "bottom-right-end",
		});

		expect(resolved.topLeftSegments).toEqual(["path"]);
		expect(resolved.topRightSegments).toEqual(["model"]);
		expect(resolved.bottomLeftSegments).toEqual(["elapsed"]);
		expect(resolved.bottomRightSegments).toEqual(["context", "working"]);
	});
});
