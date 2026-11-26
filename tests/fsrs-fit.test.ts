/**
 * FSRS-7 fitting (docs/fsrs7-plan.md): training items from memory events,
 * the 100-item gate, the fsrs-rs optimizer (local native code, no model
 * calls), and the fitted-weights store with its fallbacks and refit guard.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FSRS_DEFAULT_WEIGHTS, type TrainingReview } from "../src/core/memory/fsrs.ts";
import { FIT_GATE_ITEMS, fitWeights } from "../src/core/memory/fit.ts";
import { trainingItems, type MemoryEvent, type MemoryItem } from "../src/core/memory/items.ts";
import { createFsrsWeightsStore } from "../src/store/fsrs-weights.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-fsrs-")), "memory", "fsrs-weights.json");

const item = (events: Array<Omit<MemoryEvent, "itemId">>): MemoryItem => ({
	id: "n", title: "N", kind: "definition", statement: "N.", scopeDraft: false, retired: false, status: "scheduled", mastery: "solid",
	credited: [], retained: [], depthMissing: [], evidenceCount: 1, chatId: "c", chatIds: ["c"], everMature: false, events: events.map((e) => ({ itemId: "n", ...e })),
});

/** A synthetic but plausible log: Good-ish histories with growing gaps. */
function syntheticItems(count: number): TrainingReview[][] {
	const out: TrainingReview[][] = [];
	for (let i = 0; out.length < count; i++) {
		const ratings = [3, i % 3 === 0 ? 1 : 3, i % 5 === 0 ? 2 : 3, 3] as const;
		const gaps = [0, 1 + (i % 4), 4 + (i % 7), 12 + (i % 11)];
		const reviews = ratings.map((rating, k) => ({ rating, deltaT: gaps[k]! + (k ? 0.3 : 0) }));
		for (let k = 2; k <= reviews.length && out.length < count; k++) out.push(reviews.slice(0, k));
	}
	return out;
}

describe("training items", () => {
	it("every prefix of two or more seed/review events, with fractional-day gaps; retries and follow-ups excluded", () => {
		const items = trainingItems([item([
			{ kind: "seed", at: iso(T0), rating: 2 },
			{ kind: "review", at: iso(T0 + 1.5 * DAY), rating: 1 },
			{ kind: "retry", at: iso(T0 + 1.6 * DAY), rating: 3 },
			{ kind: "followup", at: iso(T0 + 1.7 * DAY), rating: 3 },
			{ kind: "review", at: iso(T0 + 3.5 * DAY), rating: 3 },
		])]);
		assert.deepEqual(items, [
			[{ rating: 2, deltaT: 0 }, { rating: 1, deltaT: 1.5 }],
			[{ rating: 2, deltaT: 0 }, { rating: 1, deltaT: 1.5 }, { rating: 3, deltaT: 2 }],
		]);
	});

	it("a seed alone is not a training item", () => {
		assert.deepEqual(trainingItems([item([{ kind: "seed", at: iso(T0), rating: 3 }])]), []);
	});
});

describe("fitWeights", () => {
	it("does not fit below the gate", async () => {
		assert.equal(FIT_GATE_ITEMS, 100);
		assert.equal(await fitWeights(syntheticItems(FIT_GATE_ITEMS - 1)), null);
	});

	it("fits 34 valid FSRS-7 weights at the gate", async () => {
		const result = await fitWeights(syntheticItems(FIT_GATE_ITEMS));
		assert.ok(result);
		assert.equal(result.items, FIT_GATE_ITEMS);
		assert.equal(result.weights.length, 34);
		assert.ok(result.weights.some((w, i) => Math.abs(w - FSRS_DEFAULT_WEIGHTS[i]!) > 1e-6), "the optimizer moved at least one weight");
	});
});

describe("fitted weights store", () => {
	it("reads undefined when missing, corrupt, wrong version or out of bounds", () => {
		const file = tmp();
		const store = createFsrsWeightsStore(file);
		assert.equal(store.read(), undefined);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		for (const text of ["{not json", JSON.stringify({ version: "FSRS-6", weights: FSRS_DEFAULT_WEIGHTS }), JSON.stringify({ version: "FSRS-7", weights: [1, 2, 3] })]) {
			fs.writeFileSync(file, text);
			// A new store each time: the cache keys on mtime+size, which can repeat within a tick.
			assert.equal(createFsrsWeightsStore(file).read(), undefined, text);
		}
	});

	it("a refit writes the record, and reads return the weights", async () => {
		const file = tmp();
		const weights = FSRS_DEFAULT_WEIGHTS.map((w, i) => (i === 2 ? w * 1.5 : w));
		const store = createFsrsWeightsStore(file, { fit: async (items) => ({ weights, items: items.length }), now: () => T0 });
		await store.refit(syntheticItems(3));
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { version: "FSRS-7", weights, items: 3, fittedAt: iso(T0) });
		assert.deepEqual(store.read(), weights);
		assert.equal(store.read(), store.read(), "same array while the file is unchanged");
	});

	it("below the gate, a failed fit or a concurrent refit leaves the weights alone", async () => {
		const file = tmp();
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const store = createFsrsWeightsStore(file, { fit: async () => { calls++; await gate; return null; } });
		const first = store.refit([]);
		await store.refit([]);
		assert.equal(calls, 1, "a refit while one runs is skipped");
		release();
		await first;
		assert.equal(fs.existsSync(file), false, "a null fit writes nothing");
		const failing = createFsrsWeightsStore(file, { fit: async () => { throw new Error("boom"); } });
		await failing.refit([]); // resolves; the error is logged
		assert.equal(failing.read(), undefined);
	});
});
