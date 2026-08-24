import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TerminalOutput } from "../src/terminal/output.ts";
import { type ProjectionScheduler, type ProjectionTimer, TerminalProjection } from "../src/terminal/projection.ts";

interface ScheduledTask {
	at: number;
	callback: () => void;
	cancelled: boolean;
}

class FakeScheduler implements ProjectionScheduler {
	currentTime = 1_000;
	readonly tasks: ScheduledTask[] = [];

	now(): number {
		return this.currentTime;
	}

	schedule(callback: () => void, delayMs: number): ProjectionTimer {
		const task = { at: this.currentTime + delayMs, callback, cancelled: false };
		this.tasks.push(task);
		return { dispose: () => (task.cancelled = true) };
	}

	advance(milliseconds = 0): void {
		this.currentTime += milliseconds;
		for (;;) {
			const task = this.tasks.find((candidate) => !candidate.cancelled && candidate.at <= this.currentTime);
			if (!task) return;
			task.cancelled = true;
			task.callback();
		}
	}

	get pending(): number {
		return this.tasks.filter((task) => !task.cancelled).length;
	}
}

async function write(projection: TerminalProjection, data: string): Promise<void> {
	projection.write(data);
	await projection.drain();
}

test("TerminalOutput consumes cumulative append snapshots without retaining or replaying their prefix", async () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 4, maxRows: 4 });
	output.appendCumulative("progress 10%\r");
	output.appendCumulative("progress 10%\rprogress 100%\n");
	await output.drain();
	expect(output.render(40)).toEqual(["progress 100%"]);
	output.dispose();
});

test("TerminalOutput renders the initial PTY snapshot during a synchronous repaint", () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 4, maxRows: 4 });
	output.setText("progress 10%\rprogress 100%\n");

	expect(output.render(40).map((line) => stripTerminalSequences(line))).toEqual(["progress 100%"]);
	output.dispose();
});

test("TerminalOutput preserves PTY state when a caller selects cumulative-tail mode", async () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 4, maxRows: 4 });
	const cumulative = `\x1b[31m${"red ".repeat(80)}`;
	output.appendCumulative(cumulative);
	await output.drain();
	output.appendCumulativeTail(cumulative.slice(-100));
	await output.drain();

	const rendered = output.render(40);
	expect(rendered.some((line) => line.includes("31m"))).toBe(true);
	output.dispose();
});

test("TerminalOutput always replaces stale output even when replacement starts with an old tail", async () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 4, maxRows: 4 });
	output.setText(`stale output\nshared-prefix-123456`);
	output.setText("shared-prefix-123456\nauthoritative output");
	await output.drain();

	const rendered = output.render(40).join("\n");
	expect(rendered).toContain("authoritative output");
	expect(rendered).not.toContain("stale output");
	output.dispose();
});

test("TerminalOutput appends a complete cumulative replacement without replaying its prefix", async () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 4, maxRows: 4 });
	output.appendCumulative("one\r\n");
	output.setText("one\r\ntwo");
	await output.drain();

	expect(output.render(40).join("\n")).toContain("one\ntwo");
	output.dispose();
});

test("TerminalOutput exposes an omitted-prefix row for bounded history", async () => {
	const output = new TerminalOutput({ requestRender() {}, cols: 40, rows: 8, maxRows: 3 });
	output.setText("one\r\ntwo\r\nthree\r\nfour\r\nfive");
	await output.drain();

	expect(output.render(40).map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
		"… 3 rows omitted …",
		"four",
		"five",
	]);
	expect(output.getOmissionRow()).toBe(0);
	output.dispose();
});

test("TerminalOutput delegates burst repaint throttling to its projection", async () => {
	let renders = 0;
	const output = new TerminalOutput({ requestRender: () => renders++, cols: 40, rows: 4, maxRows: 4 });
	let cumulative = "";
	for (let index = 0; index < 100; index++) {
		cumulative += "x";
		output.appendCumulative(cumulative);
	}
	await output.drain();

	// Parsing does not bypass TerminalProjection's scheduled repaint path.
	expect(renders).toBe(0);
	expect(output.render(40).join("\n")).toContain("x".repeat(40));
	output.dispose();
});

test("TerminalOutput never repaints after disposal", async () => {
	let renders = 0;
	const output = new TerminalOutput({ requestRender: () => renders++, cols: 40, rows: 4 });
	output.setText("queued");
	output.dispose();
	await Bun.sleep(0);
	expect(renders).toBe(0);
});

describe("TerminalProjection", () => {
	test("hard-bounds dimensions, scrollback, and rendered history", async () => {
		const projection = new TerminalProjection({
			requestRender() {},
			cols: 1_000_000,
			rows: 1_000_000,
			scrollback: 1_000_000,
		});
		expect(projection.cols).toBe(500);
		expect(projection.rows).toBe(200);
		projection.write("one\ntwo\nthree");
		await projection.drain();
		expect(projection.renderLines({ includeScrollback: true, maxRows: 2 })).toHaveLength(2);
		projection.dispose();
	});

	test("projects carriage return, backspace, erase, and cursor movement", async () => {
		const projection = new TerminalProjection({ requestRender() {}, cols: 8, rows: 3 });
		await write(projection, "abc\rZ\bY");
		expect(projection.renderLines()[0]).toBe(`Y${CURSOR_MARKER}bc`);

		await write(projection, "\r\x1b[3C\x1b[K");
		expect(projection.renderLines()[0]).toBe(`Ybc${CURSOR_MARKER}`);

		await write(projection, "\x1b[2;3HX");
		expect(projection.renderLines()[1]).toBe(`  X${CURSOR_MARKER}`);
		projection.dispose();
	});

	test("preserves wide glyph cell geometry", async () => {
		const projection = new TerminalProjection({ requestRender() {}, cols: 8, rows: 2 });
		await write(projection, "界x");
		expect(projection.renderLines()[0]).toBe(`界x${CURSOR_MARKER}`);
		projection.dispose();
	});

	test("replays only cell SGR and drops terminal side effects", async () => {
		const projection = new TerminalProjection({ requestRender() {}, cols: 12, rows: 2 });
		await write(projection, "\x1b]2;secret title\x07\x1b]52;c;c2VjcmV0\x07\x1b[31;1mred\x1b[0m");
		const rendered = projection.renderLines({ cursor: false })[0] ?? "";

		expect(rendered).toContain("\x1b[0;1;31mred\x1b[0m");
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("\x1b]");
		projection.dispose();
	});

	test("bounds scrollback and reflows on resize", async () => {
		const projection = new TerminalProjection({ requestRender() {}, cols: 6, rows: 2, scrollback: 2 });
		await write(projection, "1\r\n2\r\n3\r\n4\r\n5");
		const history = projection.renderLines({ includeScrollback: true, cursor: false });

		expect(history.length).toBeLessThanOrEqual(4);
		expect(history.at(-1)).toBe("5");
		expect(projection.resize(3, 3)).toBe(true);
		expect(projection.resize(3, 3)).toBe(false);
		expect(projection).toMatchObject({ cols: 3, rows: 3 });
		projection.dispose();
	});

	test("reuses projected cells until terminal state or dimensions change", async () => {
		const projection = new TerminalProjection({ requestRender() {}, cols: 20, rows: 2 });
		await write(projection, "stable");
		const first = projection.renderLines({ includeScrollback: true, cursor: false });
		expect(projection.renderLines({ includeScrollback: true, cursor: false })).toBe(first);
		expect(projection.renderLines({ includeScrollback: false, cursor: false })).not.toBe(first);
		projection.resize(10, 2);
		expect(projection.renderLines({ includeScrollback: true, cursor: false })).not.toBe(first);
		projection.dispose();
	});

	test("coalesces burst repaint requests without sleeping", async () => {
		const scheduler = new FakeScheduler();
		let renders = 0;
		const projection = new TerminalProjection({
			requestRender: () => (renders += 1),
			cols: 20,
			rows: 2,
			repaintIntervalMs: 40,
			scheduler,
		});

		for (let index = 0; index < 1_000; index += 1) projection.write(String(index % 10));
		await projection.drain();
		expect(scheduler.pending).toBe(1);
		scheduler.advance();
		expect(renders).toBe(1);

		await write(projection, "next");
		await write(projection, "frame");
		expect(scheduler.pending).toBe(1);
		scheduler.advance(39);
		expect(renders).toBe(1);
		scheduler.advance(1);
		expect(renders).toBe(2);
		projection.dispose();
	});

	test("cancels repaint work and ignores writes after disposal", async () => {
		const scheduler = new FakeScheduler();
		let renders = 0;
		const projection = new TerminalProjection({
			requestRender: () => (renders += 1),
			scheduler,
		});
		await write(projection, "queued");
		expect(scheduler.pending).toBe(1);

		projection.dispose();
		expect(scheduler.pending).toBe(0);
		projection.write("ignored");
		scheduler.advance(1_000);
		expect(renders).toBe(0);
		expect(projection.renderLines()).toEqual([]);
	});

	test("contains consumer repaint failures", async () => {
		const scheduler = new FakeScheduler();
		const projection = new TerminalProjection({
			requestRender() {
				throw new Error("host repaint failed");
			},
			scheduler,
		});
		await write(projection, "queued");
		expect(() => scheduler.advance()).not.toThrow();
		projection.dispose();
	});
});
