/**
 * Retention mode, phase 1: per-node forgetting curves derived from the
 * math evidence ledger (src/core/memory/*). Design: docs/retention-mode-plan.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceRecord } from "../src/core/math-evidence.ts";
import { dueAt, intervalDays, rateFsrs, retrievability, retrievabilityAt } from "../src/core/memory/fsrs.ts";
import { curvePoints, memoryItems, memorySnapshot, replay, seedFor, type MemoryEvent } from "../src/core/memory/items.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	id: "r", chatId: "c1", nodeId: "n", nodeTitle: "Node", dimension: "K", outcome: "correct",
	hints: 0, note: "note", recordedAt: iso(T0), ...over,
});

describe("FSRS core", () => {
	it("recall is 1 at review time, 0.9 after one stability, and falls monotonically", () => {
		assert.equal(retrievability(0, 5), 1);
		assert.ok(Math.abs(retrievability(5, 5) - 0.9) < 1e-9);
		assert.ok(retrievability(10, 5) < retrievability(5, 5));
	});

	it("the interval for 0.9 retention equals the stability, and is longer for lower retention", () => {
		assert.ok(Math.abs(intervalDays(7, 0.9) - 7) < 1e-6);
		assert.ok(intervalDays(7, 0.85) > 7);
		assert.ok(Math.abs(retrievability(intervalDays(7, 0.85), 7) - 0.85) < 1e-7);
	});

	it("first ratings order stabilities Again < Hard < Good < Easy", () => {
		const s = ([1, 2, 3, 4] as const).map((r) => rateFsrs(null, r, T0).stability);
		assert.deepEqual([...s].sort((a, b) => a - b), s);
		assert.equal(rateFsrs(null, 3, T0).reps, 1);
	});

	it("a successful review after the interval grows stability; a lapse shrinks it and counts", () => {
		const first = rateFsrs(null, 3, T0);
		const later = T0 + Math.round(first.stability) * DAY;
		const good = rateFsrs(first, 3, later);
		const again = rateFsrs(first, 1, later);
		assert.ok(good.stability > first.stability);
		assert.ok(again.stability < first.stability);
		assert.equal(again.lapses, 1);
		assert.equal(good.lastReview, later);
	});

	it("an Again is due no sooner than a day later", () => {
		const state = rateFsrs(null, 1, T0);
		assert.ok(dueAt(state, 0.85, 1) >= T0 + DAY);
		assert.equal(retrievabilityAt(state, T0), 1);
	});
});

describe("memory items from the ledger", () => {
	it("seeds Good for a solid node with clean K and a deeper dimension credited after the teaching window", () => {
		const later = T0 + 86_400_000;
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "U", recordedAt: iso(later) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 3, at: iso(later) });
	});

	it("caps the seed at Hard when every credit was earned while the node was taught", () => {
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "U", recordedAt: iso(T0 + 1000) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 2, at: iso(T0 + 1000) });
	});

	it("seeds Hard for a solid node reached slowly", () => {
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "S", outcome: "correct_slow" })]);
		assert.equal(seed!.rating, 2);
	});

	it("seeds Again at the last attempt for an in-progress node", () => {
		const seed = seedFor([record({ id: "a", outcome: "partial", recordedAt: iso(T0 + 5) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 1, at: iso(T0 + 5) });
	});

	it("an assumed-only node is unverified with no schedule", () => {
		const items = memoryItems([record({ outcome: "assumed" })]);
		assert.equal(items.length, 1);
		assert.equal(items[0]!.status, "unverified");
		assert.equal(items[0]!.state, undefined);
		const [snap] = memorySnapshot([record({ outcome: "assumed" })], T0);
		assert.equal(snap!.due, true);
		assert.equal(snap!.stale, false);
	});

	it("keys items by session and node, so one node in two sessions is two items", () => {
		const items = memoryItems([record({ id: "a" }), record({ id: "b", dimension: "U" }), record({ id: "c", chatId: "c2" }), record({ id: "d", chatId: "c2", dimension: "S" })]);
		assert.deepEqual(items.map((i) => i.id).sort(), ["c1#n", "c2#n"]);
	});

	it("replay ignores retries", () => {
		const seed: MemoryEvent = { itemId: "x", at: iso(T0), kind: "seed", rating: 3 };
		const retry: MemoryEvent = { itemId: "x", at: iso(T0 + 3 * DAY), kind: "retry", rating: 1 };
		assert.deepEqual(replay([seed, retry]), replay([seed]));
	});

	it("a solid node becomes stale once its recall falls below the retention target", () => {
		const records = [record({ id: "a" }), record({ id: "b", dimension: "U" })];
		const [fresh] = memorySnapshot(records, T0 + 1000);
		assert.equal(fresh!.stale, false);
		assert.equal(fresh!.due, false);
		const [old] = memorySnapshot(records, T0 + 120 * DAY);
		assert.equal(old!.stale, true);
		assert.equal(old!.due, true);
		assert.ok(old!.retrievability < 0.85);
	});

	it("a later review moves the schedule and the curve jumps back to full recall", () => {
		const records = [record({ id: "a" }), record({ id: "b", dimension: "U" })];
		const review: MemoryEvent = { itemId: "c1#n", at: iso(T0 + 30 * DAY), kind: "review", rating: 3 };
		const [withReview] = memorySnapshot(records, T0 + 30 * DAY, { reviews: [review] });
		assert.equal(withReview!.retrievability, 1);
		assert.equal(withReview!.state!.reps, 2);
		const curve = curvePoints(withReview!, T0 + 40 * DAY, 4);
		assert.equal(curve[0]![1], 1);
		assert.ok(curve.some(([t, r]) => t === T0 + 30 * DAY && r === 1));
	});

	it("sorts the snapshot most forgotten first", () => {
		const records = [
			record({ id: "a", nodeId: "old", nodeTitle: "Old" }), record({ id: "b", nodeId: "old", nodeTitle: "Old", dimension: "U" }),
			record({ id: "c", nodeId: "new", nodeTitle: "New", recordedAt: iso(T0 + 20 * DAY) }), record({ id: "d", nodeId: "new", nodeTitle: "New", dimension: "U", recordedAt: iso(T0 + 20 * DAY) }),
		];
		assert.deepEqual(memorySnapshot(records, T0 + 25 * DAY).map((i) => i.title), ["Old", "New"]);
	});
});
