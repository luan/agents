import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	beginNotebookJournalCell,
	finishNotebookJournalCell,
	initializeNotebookJournal,
	materializeNotebookJournal,
	readNotebookJournalCodeCells,
} from "./journal.ts";

const MAX_BYTES = 16_384;

it("rotates at the persistence budget and keeps one previous document", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-journal-"));
	try {
		const journal = initializeNotebookJournal({ project: agentDir, session: "session", agentDir }, MAX_BYTES);
		const source = `const old = ${JSON.stringify("x".repeat(11_000))};`;
		beginNotebookJournalCell(journal, { id: "cell-1", source });
		finishNotebookJournalCell(journal, { id: "cell-1", source, outcome: { status: "ok" } });
		expect(statSync(journal.path).size + statSync(journal.eventsPath).size).toBeLessThanOrEqual(MAX_BYTES);
		materializeNotebookJournal(journal);
		expect(statSync(journal.path).size).toBeLessThanOrEqual(MAX_BYTES);
		expect(statSync(previousPath(journal.path)).size).toBeLessThanOrEqual(MAX_BYTES);

		expect(readNotebookJournalCodeCells(journal.path).map(({ id }) => id)).toEqual(["cell-1"]);
		expect(readNotebookJournalCodeCells(previousPath(journal.path)).map(({ id }) => id)).toEqual(["cell-1"]);
		const document = JSON.parse(readFileSync(journal.path, "utf8")) as { cells: Array<{ id?: string }> };
		expect(document.cells[0]?.id).toBe("cell-1");

		// An oversize previous document is dropped on the next startup, not carried forward.
		writeFileSync(previousPath(journal.path), "x".repeat(MAX_BYTES + 1));
		initializeNotebookJournal({ project: agentDir, session: "session", agentDir }, MAX_BYTES);
		expect(existsSync(previousPath(journal.path))).toBe(false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("materializes a standard nbformat 4.5 notebook with outputs and errors", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-journal-doc-"));
	try {
		const journal = initializeNotebookJournal({ project: agentDir, session: "session", agentDir }, MAX_BYTES);
		beginNotebookJournalCell(journal, { id: "cell-1", source: "1 + 1" });
		finishNotebookJournalCell(journal, {
			id: "cell-1",
			source: "1 + 1",
			outcome: {
				status: "error",
				output: "printed",
				images: [{ data: "QUJD", mimeType: "image/png" }],
				error: "boom",
			},
		});
		materializeNotebookJournal(journal);
		const document = JSON.parse(readFileSync(journal.path, "utf8")) as {
			nbformat: number;
			nbformat_minor: number;
			cells: Array<{
				cell_type: string;
				outputs: Array<Record<string, unknown>>;
				metadata: { pi: { status: string } };
			}>;
		};
		expect([document.nbformat, document.nbformat_minor]).toEqual([4, 5]);
		expect(document.cells).toHaveLength(1);
		expect(document.cells[0]?.cell_type).toBe("code");
		expect(document.cells[0]?.metadata.pi.status).toBe("error");
		expect(document.cells[0]?.outputs.map((output) => output["output_type"])).toEqual([
			"stream",
			"display_data",
			"error",
		]);
		expect(document.cells[0]?.outputs[1]?.["data"]).toEqual({ "image/png": "QUJD" });
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("survives a torn last event line but rejects a corrupt earlier one", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-journal-torn-"));
	try {
		const journal = initializeNotebookJournal({ project: agentDir, session: "session", agentDir }, MAX_BYTES);
		beginNotebookJournalCell(journal, { id: "cell-1", source: "1" });
		writeFileSync(journal.eventsPath, `${readFileSync(journal.eventsPath, "utf8")}{"type":"begin","id":"cell-2"`);
		expect(readNotebookJournalCodeCells(journal.path).map(({ id }) => id)).toEqual(["cell-1"]);

		writeFileSync(journal.eventsPath, '{"type":"begin"}\n');
		expect(() => readNotebookJournalCodeCells(journal.path)).toThrow(/Notebook journal events are invalid/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

function previousPath(path: string): string {
	return path.replace(/\.ipynb$/, ".previous.ipynb");
}
