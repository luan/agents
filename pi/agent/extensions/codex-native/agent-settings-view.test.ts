import { expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AgentSettingsPanel, type AgentSettingsRow, type AgentSettingsTab } from "./agent-settings-view.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

/** A row whose current value the test can read without going through the rendered frame. */
function stepRow(label: string, values: string[]) {
	let index = 0;
	const row: AgentSettingsRow = {
		id: label,
		label,
		description: `${label} description`,
		value: () => values[index]!,
		onStep: (delta) => {
			index = (index + delta + values.length) % values.length;
		},
	};
	return { row, value: () => values[index]! };
}

function panel(tabs: AgentSettingsTab[]) {
	let closed = false;
	const errors: string[] = [];
	const view = new AgentSettingsPanel(
		theme,
		tabs,
		() => {},
		() => {
			closed = true;
		},
		(_error, rowId) => errors.push(rowId),
	);
	return { view, errors, wasClosed: () => closed };
}

function tab(id: string, rows: AgentSettingsRow[]): AgentSettingsTab {
	return { id, label: id, hint: "", rows: () => rows };
}

it("steps the selected row forwards and backwards", async () => {
	const code = stepRow("Code Mode", ["on", "off"]);
	const { view } = panel([tab("code", [code.row])]);

	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(code.value()).toBe("off");

	view.handleInput(LEFT);
	await view.waitForPendingActions();
	expect(code.value()).toBe("on");
});

it("cycles a row with more than two values and wraps", async () => {
	const edit = stepRow("Edit mode", ["hashline", "apply_patch", "replace"]);
	const { view } = panel([tab("edit", [edit.row])]);

	for (const expected of ["apply_patch", "replace", "hashline"]) {
		view.handleInput(RIGHT);
		await view.waitForPendingActions();
		expect(edit.value()).toBe(expected);
	}
});

it("filters with printable keys, including the ones that used to navigate", async () => {
	// `h`, `l`, `j`, `k` and `q` were navigation or close keys before this panel was reworked.
	const hashline = stepRow("Hashline", ["on", "off"]);
	const quiet = stepRow("Quiet loop", ["on", "off"]);
	const { view } = panel([tab("t", [hashline.row, quiet.row])]);

	for (const key of "quiet") view.handleInput(key);
	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(quiet.value()).toBe("off");
	expect(hashline.value()).toBe("on");

	for (let index = 0; index < "quiet".length; index++) view.handleInput(BACKSPACE);
	for (const key of "hl") view.handleInput(key);
	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(hashline.value()).toBe("off");
});

it("closes on escape and never on a printable key", () => {
	const { view, wasClosed } = panel([tab("t", [stepRow("Code Mode", ["on"]).row])]);

	for (const key of ["q", "h", "l", "j", "k", " ", "3"]) {
		view.handleInput(key);
		expect(wasClosed()).toBe(false);
	}
	view.handleInput(ESCAPE);
	expect(wasClosed()).toBe(true);
});

it("jumps to a row by its number", async () => {
	const rows = ["one", "two", "three"].map((name) => stepRow(name, ["on", "off"]));
	const { view } = panel([
		tab(
			"t",
			rows.map((entry) => entry.row),
		),
	]);

	view.handleInput("3");
	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(rows.map((entry) => entry.value())).toEqual(["on", "on", "off"]);
});

it("drops a second step while the first write is in flight", async () => {
	let inFlight = 0;
	let peak = 0;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow: AgentSettingsRow = {
		id: "slow",
		label: "Slow",
		description: "",
		value: () => "on",
		onStep: async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gate;
			inFlight -= 1;
		},
	};
	const { view } = panel([tab("t", [slow])]);

	view.handleInput(RIGHT);
	view.handleInput(RIGHT);
	view.handleInput(RIGHT);
	release();
	await view.waitForPendingActions();
	expect(peak).toBe(1);
});

it("reports which row failed to save", async () => {
	const failing: AgentSettingsRow = {
		id: "boom",
		label: "Boom",
		description: "",
		value: () => "on",
		onStep: () => {
			throw new Error("write failed");
		},
	};
	const { view, errors } = panel([tab("t", [failing])]);

	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(errors).toEqual(["boom"]);
});

it("switches tabs and drops the filter", async () => {
	const code = stepRow("Code Mode", ["on", "off"]);
	const edit = stepRow("Edit mode", ["hashline", "replace"]);
	const { view } = panel([tab("code", [code.row]), tab("edit", [edit.row])]);

	view.handleInput("z"); // matches nothing on either tab
	view.handleInput("\t");
	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(edit.value()).toBe("replace");
	expect(code.value()).toBe("on");
});

it("steps nothing when the filter matches no row", async () => {
	const code = stepRow("Code Mode", ["on", "off"]);
	const { view } = panel([tab("t", [code.row])]);

	view.handleInput("z");
	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(code.value()).toBe("on");
});

it("survives a row list that shrinks under the cursor", async () => {
	const rows = ["one", "two", "three"].map((name) => stepRow(name, ["on", "off"]));
	let visible = rows.map((entry) => entry.row);
	const { view } = panel([{ id: "t", label: "t", hint: "", rows: () => visible }]);

	view.handleInput("3");
	visible = visible.slice(0, 1);
	expect(() => view.render(60)).not.toThrow();

	view.handleInput(RIGHT);
	await view.waitForPendingActions();
	expect(rows[0]!.value()).toBe("off");
});
