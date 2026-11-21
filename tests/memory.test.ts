/**
 * Retention mode, phase 1: per-node forgetting curves derived from the
 * math evidence ledger (src/core/memory/*). Design: docs/retention-mode-plan.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceRecord } from "../src/core/math-evidence.ts";
import { daysTo90, dueAt, FSRS_DEFAULT_WEIGHTS, intervalDays, rateFsrs, retrievability, retrievabilityAt } from "../src/core/memory/fsrs.ts";
import { curvePoints, memoryItems, memorySnapshot, replay, seedFor, type MemoryEvent } from "../src/core/memory/items.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	id: "r", chatId: "c1", nodeId: "n", nodeTitle: "Node", dimension: "K", outcome: "correct",
	hints: 0, note: "note", recordedAt: iso(T0), ...over,
});

describe("FSRS core (ts-fsrs FSRS-7)", () => {
	it("first ratings start at the library's default stabilities", () => {
		const s = ([1, 2, 3, 4] as const).map((r) => rateFsrs(null, r, T0).stability);
		assert.deepEqual(s, [0.1104, 2.2395, 3.9221, 11.7841]);
		assert.deepEqual(s, FSRS_DEFAULT_WEIGHTS.slice(0, 4));
		const first = rateFsrs(null, 3, T0);
		assert.equal(first.reps, 1);
		assert.equal(first.lastReview, T0);
		assert.ok(first.stabilityFast > 0);
	});

	it("recall is about 1 at review time and falls monotonically", () => {
		const state = rateFsrs(null, 3, T0);
		assert.ok(retrievability(state, 0) > 0.9999);
		assert.ok(retrievability(state, 2) < retrievability(state, 0));
		assert.ok(retrievability(state, 10) < retrievability(state, 2));
		assert.equal(retrievabilityAt(state, T0 + 2 * DAY), retrievability(state, 2));
	});

	it("intervalDays inverts the curve, and lower retention waits longer", () => {
		const state = rateFsrs(null, 3, T0);
		assert.ok(intervalDays(state, 0.85) > intervalDays(state, 0.9));
		assert.ok(Math.abs(retrievability(state, intervalDays(state, 0.85)) - 0.85) < 1e-4);
		assert.equal(daysTo90(state), intervalDays(state, 0.9));
		assert.throws(() => intervalDays(state, 1), RangeError);
	});

	it("a successful review after the interval grows memory; a lapse shrinks it and counts", () => {
		const first = rateFsrs(null, 3, T0);
		const later = T0 + Math.round(intervalDays(first, 0.85)) * DAY;
		const good = rateFsrs(first, 3, later);
		const again = rateFsrs(first, 1, later);
		assert.ok(daysTo90(good) > daysTo90(first));
		assert.ok(again.stability < first.stability);
		assert.equal(again.lapses, 1);
		assert.equal(good.lapses, 0);
		assert.equal(good.lastReview, later);
		assert.equal(good.reps, 2);
	});

	it("a same-day Again is not a lapse", () => {
		const first = rateFsrs(null, 3, T0);
		assert.equal(rateFsrs(first, 1, T0 + 3_600_000).lapses, 0);
	});

	it("an Again is due no sooner than a day later", () => {
		const state = rateFsrs(null, 1, T0);
		assert.ok(intervalDays(state, 0.85) < 1);
		assert.ok(dueAt(state, 0.85, 1) >= T0 + DAY);
		assert.equal(dueAt(state, 0.85), T0 + intervalDays(state, 0.85) * DAY);
	});

	it("custom weights change the schedule", () => {
		const weights = FSRS_DEFAULT_WEIGHTS.map((w, i) => (i === 2 ? w * 2 : w));
		assert.equal(rateFsrs(null, 3, T0, weights).stability, FSRS_DEFAULT_WEIGHTS[2]! * 2);
		const a = rateFsrs(null, 3, T0);
		const b = rateFsrs(null, 3, T0, weights);
		assert.ok(daysTo90(b, weights) > daysTo90(a));
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
		// FSRS-7's curve starts at 0.99999 by design (ts-fsrs migration guide).
		assert.ok(withReview!.retrievability > 0.9999);
		assert.equal(withReview!.state!.reps, 2);
		const curve = curvePoints(withReview!, T0 + 40 * DAY, 4);
		assert.ok(curve[0]![1] > 0.9999);
		assert.ok(curve.some(([t, r]) => t === T0 + 30 * DAY && r > 0.9999));
	});

	it("sorts the snapshot most forgotten first", () => {
		const records = [
			record({ id: "a", nodeId: "old", nodeTitle: "Old" }), record({ id: "b", nodeId: "old", nodeTitle: "Old", dimension: "U" }),
			record({ id: "c", nodeId: "new", nodeTitle: "New", recordedAt: iso(T0 + 20 * DAY) }), record({ id: "d", nodeId: "new", nodeTitle: "New", dimension: "U", recordedAt: iso(T0 + 20 * DAY) }),
		];
		assert.deepEqual(memorySnapshot(records, T0 + 25 * DAY).map((i) => i.title), ["Old", "New"]);
	});
});
