/**
 * Fitted FSRS-7 weights — fs adapter for core/memory/fsrs.ts's
 * FsrsWeightsStore: data/memory/fsrs-weights.json, written whole (atomic)
 * by each successful refit (docs/fsrs7-plan.md). Missing, corrupt or
 * out-of-bounds files read as undefined, so scheduling falls back to the
 * library defaults.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { checkFSRS7Parameters } from "ts-fsrs/models/fsrs-7";
import { PATHS } from "../../config.ts";
import { fitWeights, type FitResult } from "../core/memory/fit.ts";
import type { FsrsWeights, FsrsWeightsStore, TrainingReview } from "../core/memory/fsrs.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const FSRS_WEIGHTS_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "math", "fsrs-weights.json");

export interface FsrsWeightsRecord {
	version: "FSRS-7";
	weights: number[];
	/** Training items the fit used. */
	items: number;
	fittedAt: string;
}

type Fit = (items: readonly TrainingReview[][]) => Promise<FitResult | null>;

export function createFsrsWeightsStore(file: string, options: { fit?: Fit; now?: () => number } = {}): FsrsWeightsStore {
	const fit = options.fit ?? ((items) => fitWeights(items));
	const now = options.now ?? Date.now;
	// One array per file version, so fsrs.ts's per-weights cache is reused.
	let cached: { key: string; weights: FsrsWeights | undefined } | null = null;
	let running = false;

	const read = (): FsrsWeights | undefined => {
		let stat: fs.Stats;
		try { stat = fs.statSync(file); }
		catch { return undefined; }
		const key = `${stat.mtimeMs}:${stat.size}`;
		if (cached?.key === key) return cached.weights;
		let weights: FsrsWeights | undefined;
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<FsrsWeightsRecord>;
			if (record.version === "FSRS-7" && Array.isArray(record.weights)) {
				weights = Object.freeze([...checkFSRS7Parameters(record.weights)]);
			}
		} catch { weights = undefined; }
		cached = { key, weights };
		return weights;
	};

	return {
		read,
		async refit(items) {
			if (running) return;
			running = true;
			try {
				const result = await fit(items);
				if (!result) return;
				const record: FsrsWeightsRecord = { version: "FSRS-7", weights: result.weights, items: result.items, fittedAt: new Date(now()).toISOString() };
				fs.mkdirSync(path.dirname(file), { recursive: true });
				writeFileAtomicSync(file, `${JSON.stringify(record, null, "\t")}\n`);
			} catch (error) {
				console.warn("[fsrs] refit failed; keeping the current weights:", error);
			} finally {
				running = false;
			}
		},
	};
}

export const fsrsWeightsStore = createFsrsWeightsStore(FSRS_WEIGHTS_FILE);
