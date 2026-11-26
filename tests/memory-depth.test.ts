/**
 * Depth before maturity and contrast items (docs/depth-and-contrast-plan.md):
 * a clean first attempt counts as Hard until the concept kind's depth target
 * holds after the encoding window; a failed contrast keeps a confused pair at
 * Hard; look-alikes that are not due join a cluster as contrast partners.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confusablesOf, linkConfusable, type Attempt, type ConceptKind } from "../src/core/math-concepts.ts";
import { DEPTH_TARGET, memoryItems, memorySnapshot, retainedDims, trainingItems, type MemoryEvent } from "../src/core/memory/items.ts";
import { consolidationClusters, contrastPairs, firstRungFor, owedContrasts, reviewCandidates } from "../src/core/memory/review.ts";
import { concept, graphOf } from "./math-store-fixture.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const at = (over: Partial<Attempt>): Attempt => ({
	id: `a${++n}`, conceptId: "thm", chatId: "teach", at: iso(T0), source: "teach", role: "attempt", dimension: "K", outcome: "correct", hints: 0, note: "n", rating: 3, ...over,
});
/** A concept taught at T0 (K and P clean), so it is seeded and scheduled. */
const taught = (conceptId: string, kind: ConceptKind) => {
	const deep = DEPTH_TARGET[kind].find((d) => d !== "K") ?? "S";
	return [at({ conceptId }), at({ conceptId, dimension: deep, at: iso(T0 + 5 * 60_000) })];
};
const review = (conceptId: string, chatId: string, ms: number, over: Partial<Attempt> = {}) =>
	at({ conceptId, chatId, source: "consolidate", at: iso(ms), rating: 4, ...over });
const reviewEvent = (events: readonly MemoryEvent[], chatId: string) => events.find((e) => e.kind === "review" && e.chatId === chatId)!;

describe("depth before maturity", () => {
	const graph = graphOf([concept("thm", { kind: "theorem" }), concept("def", { kind: "definition" })]);

	it("a clean K first attempt alone counts as Hard while the theorem's P has not held after teaching", () => {
		const item = memoryItems(graph, [...taught("thm", "theorem"), review("thm", "c1", T0 + 10 * DAY)]).find((i) => i.id === "thm")!;
		const e = reviewEvent(item.events, "c1");
		assert.deepEqual([e.rating, e.cappedFrom, e.cappedBy, e.depthFrom], [2, 4, "depth", 4]);
		assert.deepEqual(item.retained, ["K"]);
		assert.deepEqual(item.depthMissing, ["P"]);
	});

	it("a clean P follow-up in the same sitting lifts the cap", () => {
		const item = memoryItems(graph, [
			...taught("thm", "theorem"),
			review("thm", "c1", T0 + 10 * DAY),
			review("thm", "c1", T0 + 10 * DAY + 60_000, { role: "followup", dimension: "P", rating: 3 }),
		]).find((i) => i.id === "thm")!;
		assert.equal(reviewEvent(item.events, "c1").rating, 4);
		assert.deepEqual(item.depthMissing, []);
	});

	it("depth earned in an earlier sitting carries: a later clean K keeps its Easy", () => {
		const item = memoryItems(graph, [
			...taught("thm", "theorem"),
			review("thm", "c1", T0 + 10 * DAY, { dimension: "P", rating: 3 }),
			review("thm", "c2", T0 + 30 * DAY),
		]).find((i) => i.id === "thm")!;
		assert.equal(reviewEvent(item.events, "c1").rating, 2, "P alone: K not yet retained");
		assert.equal(reviewEvent(item.events, "c2").rating, 4);
	});

	it("answers inside the encoding window are not retention", () => {
		const events: MemoryEvent[] = [
			{ itemId: "thm", at: iso(T0 + HOUR), kind: "followup", rating: 3, dimension: "P", chatId: "teach" },
			{ itemId: "thm", at: iso(T0 + 13 * HOUR), kind: "check", check: "repair", rating: 3, dimension: "K", chatId: "c1" },
			{ itemId: "thm", at: iso(T0 + 13 * HOUR), kind: "retry", rating: 3, dimension: "U", chatId: "c1" },
			{ itemId: "thm", at: iso(T0 + 14 * HOUR), kind: "check", check: "close", rating: 3, dimension: "S", chatId: "c1" },
		];
		assert.deepEqual(retainedDims(events, T0), ["S"], "only the close check counts: repairs, retries and in-window answers don't");
	});

	it("FSRS trains on what recall showed, not on the depth cap", () => {
		const items = memoryItems(graph, [...taught("thm", "theorem"), review("thm", "c1", T0 + 10 * DAY)]);
		const thm = trainingItems(items.filter((i) => i.id === "thm"));
		assert.equal(thm.at(-1)!.at(-1)!.rating, 4);
	});

	it("an item can no longer mature on the statement alone", () => {
		const attempts = [...taught("def", "definition"), ...[10, 30, 70, 150].map((d, i) => review("def", `c${i}`, T0 + d * DAY))];
		const snap = memorySnapshot(graph, attempts, T0 + 151 * DAY).find((i) => i.id === "def")!;
		assert.ok(snap.events.filter((e) => e.kind === "review").every((e) => e.rating === 2));
		const withU = [...attempts, review("def", "c3", T0 + 150 * DAY + 60_000, { role: "followup", dimension: "U", rating: 3 })];
		const lifted = memorySnapshot(graph, withU, T0 + 151 * DAY).find((i) => i.id === "def")!;
		assert.ok(lifted.daysTo90! > snap.daysTo90!, "the U follow-up restores the last Easy");
	});
});

describe("first rung", () => {
	const item = (kind: ConceptKind, retained: Array<"K" | "U" | "S" | "P">, depthMissing: Array<"K" | "U" | "S" | "P">, events: MemoryEvent[] = []) => ({ kind, retained, depthMissing, events });
	it("is K until the statement held after teaching, and whenever stale", () => {
		assert.equal(firstRungFor(item("theorem", [], ["K", "P"]), false), "K");
		assert.equal(firstRungFor(item("theorem", ["K"], ["P"]), true), "K");
	});
	it("then the missing depth dimension", () => {
		assert.equal(firstRungFor(item("theorem", ["K"], ["P"]), false), "P");
		assert.equal(firstRungFor(item("definition", ["K"], ["U"]), false), "U");
		assert.equal(firstRungFor(item("example", [], ["S"]), false), "S", "an example has no K in its target");
	});
	it("then rotates to the target dimension held longest ago", () => {
		const events: MemoryEvent[] = [
			{ itemId: "x", at: iso(T0), kind: "review", rating: 3, dimension: "P" },
			{ itemId: "x", at: iso(T0 + DAY), kind: "review", rating: 3, dimension: "K" },
		];
		assert.equal(firstRungFor(item("theorem", ["K", "P"], [], events), false), "P");
	});
	it("is on every due candidate", () => {
		const graph = graphOf([concept("thm", { kind: "theorem" })]);
		const attempts = [...taught("thm", "theorem"), review("thm", "c1", T0 + 10 * DAY, { rating: 3 })];
		// Just due (recall under 0.85, not yet stale under 0.7).
		const dueMs = Date.parse(memorySnapshot(graph, attempts, T0 + 11 * DAY)[0]!.dueAt) + 1000;
		const snapshot = memorySnapshot(graph, attempts, dueMs);
		const [c] = reviewCandidates({ snapshot, attempts, graph, sessionTitle: (id) => id, nowMs: dueMs });
		assert.deepEqual([c!.firstRung, c!.retained, c!.depthMissing], ["P", ["K"], ["P"]]);
	});
});

describe("contrast items", () => {
	const base = graphOf([concept("flux"), concept("area"), concept("div"), concept("other")]);
	const graph = linkConfusable(linkConfusable(base, "flux", "area"), "div", "flux");

	it("confusion is symmetric and read both ways", () => {
		assert.deepEqual(graph.concepts.area!.confusableWith, ["flux"]);
		assert.deepEqual(confusablesOf(graph, "flux").sort(), ["area", "div"]);
		assert.equal(linkConfusable(graph, "flux", "missing"), graph);
	});

	it("a pair confused before is required; owed until a contrast check is asked", () => {
		const attempts = [
			at({ conceptId: "flux", chatId: "old", confusedWith: "area", rating: 1 }),
			at({ conceptId: "flux", chatId: "s1", source: "consolidate", at: iso(T0 + DAY) }),
			at({ conceptId: "area", chatId: "s1", source: "consolidate", at: iso(T0 + DAY + 1) }),
		];
		assert.deepEqual(contrastPairs(graph, attempts, ["flux", "area"]), [{ itemId: "flux", partner: "area", required: true }]);
		assert.deepEqual(owedContrasts(graph, attempts, "s1").map((p) => p.partner), ["area"]);
		const asked = [...attempts, at({ conceptId: "area", chatId: "s1", role: "check", check: "contrast", pairWith: "flux", at: iso(T0 + DAY + 2) })];
		assert.deepEqual(owedContrasts(graph, asked, "s1"), [], "either way round counts");
	});

	it("a failed contrast keeps the item at Hard for that sitting", () => {
		const attempts = [
			...taught("flux", "definition"),
			review("flux", "s1", T0 + 10 * DAY),
			review("flux", "s1", T0 + 10 * DAY + 60_000, { role: "followup", dimension: "U", rating: 3 }),
			review("flux", "s1", T0 + 10 * DAY + 120_000, { role: "check", check: "contrast", pairWith: "area", dimension: "U", outcome: "incorrect", rating: 1 }),
		];
		const e = reviewEvent(memoryItems(graph, attempts).find((i) => i.id === "flux")!.events, "s1");
		assert.deepEqual([e.rating, e.cappedBy], [2, "contrast"]);
	});

	it("a look-alike that is not due joins the cluster as a contrast partner only", () => {
		const attempts = [
			...taught("flux", "definition"), ...taught("area", "definition"),
			at({ conceptId: "flux", chatId: "r", source: "review", at: iso(T0 + 2 * DAY), confusedWith: "area", rating: 1, outcome: "incorrect" }),
			review("area", "r2", T0 + 3 * DAY, { dimension: "U", rating: 3 }),
			review("area", "r2", T0 + 3 * DAY + 1, { role: "followup", rating: 3 }),
		];
		const now = T0 + 4 * DAY;
		const snapshot = memorySnapshot(graph, attempts, now);
		assert.equal(snapshot.find((i) => i.id === "area")!.due, false, "the partner is not due");
		const candidates = reviewCandidates({ snapshot, attempts, graph, sessionTitle: (id) => id, nowMs: now });
		assert.ok(candidates.some((c) => c.itemId === "flux"));
		const [cluster] = consolidationClusters({ candidates, snapshot, graph, capacity: 4, nowMs: now, attempts });
		assert.ok(cluster!.contrastPartners.includes("area"));
		assert.ok(!cluster!.itemIds.includes("area"));
		assert.deepEqual(cluster!.contrasts.find((p) => p.partner === "area"), { itemId: "flux", partner: "area", required: true });
	});
});
