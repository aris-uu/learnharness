/**
 * Retention mode: per-concept forgetting curves derived from the global
 * attempt log (src/core/memory/*). Design: docs/retention-mode-plan.md,
 * docs/global-concepts-plan.md §2.2 (one schedule rule for every session kind).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Attempt } from "../src/core/math-concepts.ts";
import { daysTo90, dueAt, FSRS_DEFAULT_WEIGHTS, intervalDays, rateFsrs, retrievability, retrievabilityAt } from "../src/core/memory/fsrs.ts";
import { curvePoints, memoryItems, memorySnapshot, replay, seedFor, type MemoryEvent } from "../src/core/memory/items.ts";
import { concept, graphOf } from "./math-store-fixture.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const record = (over: Partial<Attempt>): Attempt => ({
	id: "r", conceptId: "n-node", chatId: "c1", at: iso(T0), source: "teach", role: "attempt", dimension: "K", outcome: "correct",
	hints: 0, note: "note", rating: 3, ...over,
});
const graph = graphOf([concept("n-node"), concept("old-node"), concept("new-node"), concept("pre-node")], [{ from: "pre-node", to: "n-node" }]);

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

	it("any rated event waits at least a day: no same-day repeat after a Hard", () => {
		const state = rateFsrs(null, 2, T0);
		assert.ok(dueAt(state, 0.85, 2) >= T0 + DAY);
		assert.ok(dueAt(state, 0.85, 3) >= T0 + DAY);
	});

	it("custom weights change the schedule", () => {
		const weights = FSRS_DEFAULT_WEIGHTS.map((w, i) => (i === 2 ? w * 2 : w));
		assert.equal(rateFsrs(null, 3, T0, weights).stability, FSRS_DEFAULT_WEIGHTS[2]! * 2);
		const a = rateFsrs(null, 3, T0);
		const b = rateFsrs(null, 3, T0, weights);
		assert.ok(daysTo90(b, weights) > daysTo90(a));
	});
});

describe("memory items from the attempt log", () => {
	it("seeds Good for a solid concept with clean K and a deeper dimension credited after the teaching window", () => {
		const later = T0 + 86_400_000;
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "U", at: iso(later) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 3, at: iso(later) });
	});

	it("caps the seed at Hard when every credit was earned while the concept was taught", () => {
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "U", at: iso(T0 + 1000) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 2, at: iso(T0 + 1000) });
	});

	it("seeds Hard for a solid concept reached slowly", () => {
		const seed = seedFor([record({ id: "a" }), record({ id: "b", dimension: "S", outcome: "correct_slow", rating: 2 })]);
		assert.equal(seed!.rating, 2);
	});

	it("seeds Again at the last attempt for an in-progress concept", () => {
		const seed = seedFor([record({ id: "a", outcome: "partial", rating: 1, at: iso(T0 + 5) })]);
		assert.deepEqual(seed, { status: "scheduled", rating: 1, at: iso(T0 + 5) });
	});

	it("a concept with only unverified notes is unverified with no schedule", () => {
		const unverified = [{ id: "u", conceptId: "n-node", chatId: "c1", at: iso(T0), dimension: "K" as const, note: "claimed" }];
		const items = memoryItems(graph, [], { unverified });
		assert.equal(items.length, 1);
		assert.equal(items[0]!.status, "unverified");
		assert.equal(items[0]!.state, undefined);
		const [snap] = memorySnapshot(graph, [], T0, { unverified });
		assert.equal(snap!.due, true);
		assert.equal(snap!.stale, false);
	});

	it("one concept in two sessions is ONE item, and the later sitting's first attempt is its review", () => {
		const first = [record({ id: "a" }), record({ id: "b", dimension: "U" })];
		const later = [
			record({ id: "c", chatId: "c2", at: iso(T0 + 10 * DAY), rating: 1, outcome: "incorrect" }),
			record({ id: "d", chatId: "c2", dimension: "S", at: iso(T0 + 10 * DAY + 60_000) }),
		];
		const items = memoryItems(graph, [...first, ...later]);
		assert.deepEqual(items.map((i) => i.id), ["n-node"]);
		const moving = items[0]!.events.filter((e) => e.kind === "seed" || e.kind === "review");
		assert.deepEqual(moving.map((e) => [e.kind, e.rating, e.chatId]), [["seed", 2, "c1"], ["review", 1, "c2"]], "only the first attempt of the later sitting moves it");
		assert.deepEqual([...items[0]!.chatIds].sort(), ["c1", "c2"]);
	});

	it("replay ignores retries", () => {
		const seed: MemoryEvent = { itemId: "x", at: iso(T0), kind: "seed", rating: 3 };
		const retry: MemoryEvent = { itemId: "x", at: iso(T0 + 3 * DAY), kind: "retry", rating: 1 };
		assert.deepEqual(replay([seed, retry]), replay([seed]));
	});

	it("a solid concept becomes stale once its recall falls below the retention target", () => {
		const records = [record({ id: "a" }), record({ id: "b", dimension: "U" })];
		const [fresh] = memorySnapshot(graph, records, T0 + 1000);
		assert.equal(fresh!.stale, false);
		assert.equal(fresh!.due, false);
		const [old] = memorySnapshot(graph, records, T0 + 120 * DAY);
		assert.equal(old!.stale, true);
		assert.equal(old!.due, true);
		assert.ok(old!.retrievability < 0.85);
	});

	it("a later review moves the schedule and the curve jumps back to full recall", () => {
		const records = [record({ id: "a" }), record({ id: "b", dimension: "U" }), record({ id: "r", chatId: "rev", source: "review", at: iso(T0 + 30 * DAY), rating: 3 })];
		const [withReview] = memorySnapshot(graph, records, T0 + 30 * DAY);
		// FSRS-7's curve starts at 0.99999 by design (ts-fsrs migration guide).
		assert.ok(withReview!.retrievability > 0.9999);
		assert.equal(withReview!.state!.reps, 2);
		const curve = curvePoints(withReview!, T0 + 40 * DAY, 4);
		assert.ok(curve[0]![1] > 0.9999);
		assert.ok(curve.some(([t, r]) => t === T0 + 30 * DAY && r > 0.9999));
	});

	it("a mature concept that fails a review is relearning, not learning", () => {
		const reviews = [3, 12, 40, 110].map((d, i) => record({ id: `s${i}`, chatId: `r${i}`, source: "review", at: iso(T0 + d * DAY), rating: 3 }));
		const base = [record({ id: "k0" }), record({ id: "u0", dimension: "U", at: iso(T0 + DAY) }), ...reviews];
		const [mature] = memorySnapshot(graph, base, T0 + 111 * DAY);
		assert.equal(mature!.stage, "mature");
		const lapse = record({ id: "lapse", chatId: "r9", source: "review", at: iso(T0 + 300 * DAY), rating: 1, outcome: "incorrect" });
		const [after] = memorySnapshot(graph, [...base, lapse], T0 + 300 * DAY + 1000);
		assert.equal(after!.stage, "relearning");
	});

	it("a retired concept keeps its history and is never due", () => {
		const retired = graphOf([concept("n-node", { status: "retired" })]);
		const [snap] = memorySnapshot(retired, [record({ id: "a" }), record({ id: "b", dimension: "U" })], T0 + 120 * DAY);
		assert.equal(snap!.retired, true);
		assert.equal(snap!.due, false);
	});

	it("implicit credit (off by default) gives an almost-due prerequisite a Hard after a clean U review of its dependent", () => {
		const pre = [record({ id: "p1", conceptId: "pre-node" }), record({ id: "p2", conceptId: "pre-node", dimension: "U" })];
		const dep = [record({ id: "d1" }), record({ id: "d2", dimension: "U" })];
		const review = record({ id: "rv", chatId: "rev", source: "review", dimension: "U", at: iso(T0 + 2 * DAY), rating: 3 });
		const all = [...pre, ...dep, review];
		const off = memoryItems(graph, all).find((i) => i.id === "pre-node")!;
		const on = memoryItems(graph, all, { implicitCredit: true }).find((i) => i.id === "pre-node")!;
		assert.equal(off.events.some((e) => e.kind === "implicit"), false);
		assert.deepEqual(on.events.filter((e) => e.kind === "implicit").map((e) => [e.rating, e.via]), [[2, "n-node"]]);
		assert.ok(on.state!.reps > off.state!.reps, "the implicit Hard moved the prerequisite");
	});

	it("sorts the snapshot most forgotten first", () => {
		const records = [
			record({ id: "a", conceptId: "old-node" }), record({ id: "b", conceptId: "old-node", dimension: "U" }),
			record({ id: "c", conceptId: "new-node", at: iso(T0 + 20 * DAY) }), record({ id: "d", conceptId: "new-node", dimension: "U", at: iso(T0 + 20 * DAY) }),
		];
		assert.deepEqual(memorySnapshot(graph, records, T0 + 25 * DAY).map((i) => i.id), ["old-node", "new-node"]);
	});
});
