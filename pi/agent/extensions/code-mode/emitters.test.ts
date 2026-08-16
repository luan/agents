import { expect, it } from "bun:test";
import { CellSession, collect } from "./runtime.ts";

// Needs a real kernel: the failure lives in the agreement between the two ends. Rename the image field on either
// side, or drop a notification the host does not route, and the cell still runs green with the picture or line missing.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function sessionWithNotifications(): { session: CellSession; notified: string[] } {
	const notified: string[] = [];
	const session = new CellSession({
		callTool: () => Promise.reject(new Error("no tools in this test")),
		notify: (text) => notified.push(text),
	});
	return { session, notified };
}

it("carries an emitted image and a notification across the Rust protocol", async () => {
	const { session, notified } = sessionWithNotifications();
	const record = session.start({
		// Rust's image() takes only a data: URI or an MCP image block — no file path, no http(s) URL.
		code: `notify("progress");\nawait image(${JSON.stringify(`data:image/png;base64,${PNG_1X1}`)});\ntext("done");`,
		language: "js",
		catalog: [],
	});

	const collected = await collect(record, 9_000);
	session.reset();

	expect(collected.outcome?.error).toBeUndefined();
	expect(collected.outcome?.output).toBe("done");
	expect(notified).toEqual(["progress"]);
	expect(collected.outcome?.images).toEqual([{ data: PNG_1X1, mimeType: "image/png" }]);
});
