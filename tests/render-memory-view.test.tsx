/** THE MEMORY VIEW — SSR render pins (retention mode, phase 1). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryTable } from "../components/memory-view.tsx";
import { curvePoints, memorySnapshot, type EvidenceRecord, type MemoryView } from "../src/core/index.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	id: "r", chatId: "c1", nodeId: "n", nodeTitle: "Compactness", dimension: "K", outcome: "correct",
	hints: 0, note: "note", recordedAt: new Date(T0).toISOString(), ...over,
});

function view(nowMs: number): MemoryView {
	const records = [record({ id: "a" }), record({ id: "b", dimension: "U" }), record({ id: "c", nodeId: "m", nodeTitle: "Tychonoff", outcome: "assumed" })];
	return {
		now: nowMs,
		retention: 0.85,
		items: memorySnapshot(records, nowMs).map((item) => ({ ...item, sessionTitle: "Topology", curve: item.state ? curvePoints(item, nowMs + 14 * DAY) : [] })),
	};
}

const rows = (html: string) => html.split('data-testid="memory-row"').length - 1;

describe("memory view", () => {
	it("lists due items with a stale badge, a sparkline, and the session link", () => {
		const html = renderToStaticMarkup(<MemoryTable view={view(T0 + 120 * DAY)} filter="due" />);
		assert.equal(rows(html), 2);
		assert.match(html, /Compactness/);
		assert.match(html, /stale/);
		assert.match(html, /href="\/chat\/c1"/);
		assert.match(html, /data-testid="recall-sparkline"/);
		assert.match(html, /assumed/);
	});

	it("the due filter hides fresh items; all shows them", () => {
		const fresh = view(T0 + 1000);
		assert.equal(rows(renderToStaticMarkup(<MemoryTable view={fresh} filter="due" />)), 1);
		assert.equal(rows(renderToStaticMarkup(<MemoryTable view={fresh} filter="all" />)), 2);
	});

	it("says so when there is no evidence", () => {
		const html = renderToStaticMarkup(<MemoryTable view={{ now: T0, retention: 0.85, items: [] }} filter="due" />);
		assert.match(html, /No math-mode evidence yet/);
	});
});
