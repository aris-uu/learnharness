/** THE MEMORY VIEW — SSR render pins (retention mode; global concepts). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { MemoryTable } from "../components/memory-view.tsx";
import { curvePoints, memorySnapshot, type MemoryView } from "../src/core/index.ts";
import { attempt, concept, graphOf } from "./math-store-fixture.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = new Date(T0).toISOString();
const graph = graphOf([concept("compactness", { title: "Compactness" }), concept("tychonoff", { title: "Tychonoff" })]);

function view(nowMs: number): MemoryView {
	const attempts = [attempt("compactness", at, { chatId: "c1" }), attempt("compactness", at, { chatId: "c1", dimension: "U" })];
	const unverified = [{ id: "u", conceptId: "tychonoff", chatId: "c1", at, dimension: "K" as const, note: "claimed" }];
	return {
		now: nowMs,
		retention: 0.85,
		implicitCredit: false,
		items: memorySnapshot(graph, attempts, nowMs, { unverified }).map((item) => ({ ...item, sessionTitle: "Topology", curve: item.state ? curvePoints(item, nowMs + 14 * DAY) : [] })),
	};
}

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
const render = (el: ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{el}</AppRouterContext.Provider>);
const rows = (html: string) => html.split('data-testid="memory-row"').length - 1;

describe("memory view", () => {
	it("lists due items with stage, a stale badge, a sparkline, and the session link", () => {
		const html = render(<MemoryTable view={view(T0 + 120 * DAY)} filter="due" />);
		assert.equal(rows(html), 2);
		assert.match(html, /Compactness/);
		assert.match(html, />compactness</, "the concept id is shown");
		assert.match(html, /stale/);
		assert.match(html, /href="\/chat\/c1"/);
		assert.match(html, /data-testid="recall-sparkline"/);
		assert.match(html, /unverified/);
		assert.match(html, /data-testid="memory-stage"/);
	});

	it("the due filter hides fresh items; all shows them", () => {
		const fresh = view(T0 + 1000);
		assert.equal(rows(render(<MemoryTable view={fresh} filter="due" />)), 1);
		assert.equal(rows(render(<MemoryTable view={fresh} filter="all" />)), 2);
	});

	it("says so when there are no attempts", () => {
		const html = render(<MemoryTable view={{ now: T0, retention: 0.85, implicitCredit: false, items: [] }} filter="due" />);
		assert.match(html, /No math-mode attempts yet/);
	});
});
