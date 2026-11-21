/**
 * Fitting FSRS-7 weights to the learner's own reviews (docs/fsrs7-plan.md):
 * the fsrs-rs optimizer via @open-spaced-repetition/binding (MIT, native
 * napi). Server-only: it loads a native module.
 *
 * Gated at FIT_GATE_ITEMS training items (core/memory/items.ts
 * trainingItems). Below that the optimizer is not called and the defaults
 * stay in use; the optimizer itself returns the defaults unchanged on too
 * little data (measured 2026-11-21: still at 32 items, trains at 64).
 */
import { computeParameters, FSRSBindingItem, FSRSBindingReview } from "@open-spaced-repetition/binding";
import { checkFSRS7Parameters } from "ts-fsrs/models/fsrs-7";
import type { TrainingReview } from "./fsrs.ts";

/** About 100 graded events (consolidation-sessions-plan.md phase 4). */
export const FIT_GATE_ITEMS = 100;

export interface FitResult {
	weights: number[];
	/** Training items the fit used. */
	items: number;
}

/** Fitted FSRS-7 weights, or null below the gate. Throws if the optimizer
 *  fails or returns weights outside the model bounds. */
export async function fitWeights(items: readonly TrainingReview[][], gate = FIT_GATE_ITEMS): Promise<FitResult | null> {
	if (items.length < gate) return null;
	const train = items.map((reviews) => new FSRSBindingItem(reviews.map((r) => new FSRSBindingReview(r.rating, r.deltaT))));
	const weights = await computeParameters(train, { modelVersion: "FSRS-7", enableShortTerm: true });
	return { weights: [...checkFSRS7Parameters(weights)], items: items.length };
}
