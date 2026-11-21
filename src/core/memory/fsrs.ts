/**
 * The FSRS-7 memory model for tutor-graded review: a thin wrapper over
 * ts-fsrs 6.0.0's FSRS7Algorithm (MIT, Open Spaced Repetition), with no
 * formulas of its own (docs/fsrs7-plan.md). The wrapper adds what the
 * library's model leaves to the caller: the review timestamp, rep and lapse
 * counts, and the 1-day floor after an Again.
 *
 * Time is continuous (fractional days). FSRS-7's fast trace carries
 * same-day reviews itself, so there is no same-day branch. Learning steps,
 * fuzz and the library's scheduler are deliberately unused: a review here is
 * a tutor session, not a card flip.
 *
 * Every function takes optional `weights` (34 FSRS-7 parameters, fitted
 * from the review log by core/memory/fit.ts); omitted → library defaults.
 */
import { FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS } from "ts-fsrs/models/fsrs-7";

export type FsrsWeights = readonly number[];
export const FSRS_DEFAULT_WEIGHTS: FsrsWeights = Object.freeze([...FSRS7_DEFAULT_WEIGHTS]);

const DAY_MS = 86_400_000;

/** Again, Hard, Good, Easy. */
export type FsrsRating = 1 | 2 | 3 | 4;

export interface FsrsState {
	/** FSRS-7 slow-trace (long-term) stability, in days. Not "days to 90%": see daysTo90. */
	stability: number;
	/** FSRS-7 fast-trace stability, in days. */
	stabilityFast: number;
	/** 1 (easy) to 10 (hard). */
	difficulty: number;
	/** Epoch ms of the last rated review. */
	lastReview: number;
	reps: number;
	lapses: number;
}

/** One review in an optimizer training item: the rating and the fractional
 *  days since the previous schedule-moving event (0 for the first). */
export interface TrainingReview { rating: FsrsRating; deltaT: number }

/** The port for fitted weights (adapter: src/store/fsrs-weights.ts). */
export interface FsrsWeightsStore {
	/** Fitted weights, or undefined to use the defaults. */
	read(): FsrsWeights | undefined;
	/** Refit from `items` when there are enough of them (core/memory/fit.ts).
	 *  Fire-and-forget: never rejects, and at most one fit runs at a time. */
	refit(items: readonly TrainingReview[][]): Promise<void>;
}

const cache = new WeakMap<FsrsWeights, FSRS7Algorithm>();
function algorithm(weights: FsrsWeights = FSRS_DEFAULT_WEIGHTS): FSRS7Algorithm {
	let found = cache.get(weights);
	if (!found) {
		found = new FSRS7Algorithm(weights, FSRS7_MODEL_BOUNDS);
		cache.set(weights, found);
	}
	return found;
}

const memory = (state: FsrsState) => ({ stability: state.stability, stabilityFast: state.stabilityFast, difficulty: state.difficulty });

/** Recall probability `elapsedDays` after the last review of `state`. */
export function retrievability(state: FsrsState, elapsedDays: number, weights?: FsrsWeights): number {
	return algorithm(weights).curve(Math.max(0, elapsedDays), memory(state)).retrievability;
}

/** Recall probability of `state` at `nowMs`. */
export function retrievabilityAt(state: FsrsState, nowMs: number, weights?: FsrsWeights): number {
	return retrievability(state, (nowMs - state.lastReview) / DAY_MS, weights);
}

/** Days after the last review until recall probability falls to `retention`. */
export function intervalDays(state: FsrsState, retention: number, weights?: FsrsWeights): number {
	if (!(retention > 0 && retention < 1)) throw new RangeError("retention must be in (0, 1)");
	return algorithm(weights).next_interval(memory(state), retention);
}

/** Days until recall falls to 90%: what "stability" meant under FSRS-6, and
 *  the number shown and used for the mature line (docs/fsrs7-plan.md §2). */
export const daysTo90 = (state: FsrsState, weights?: FsrsWeights) => intervalDays(state, 0.9, weights);

/** The state after rating a review at `atMs`; `null` state = first review. */
export function rateFsrs(state: FsrsState | null, rating: FsrsRating, atMs: number, weights?: FsrsWeights): FsrsState {
	if (![1, 2, 3, 4].includes(rating)) throw new RangeError("rating must be 1–4");
	if (!Number.isFinite(atMs)) throw new RangeError("atMs must be a finite timestamp");
	const elapsed = state ? Math.max(0, (atMs - state.lastReview) / DAY_MS) : 0;
	const next = algorithm(weights).next_state(state ? memory(state) : null, elapsed, rating);
	return {
		stability: next.stability,
		stabilityFast: next.stabilityFast,
		difficulty: next.difficulty,
		lastReview: atMs,
		reps: (state?.reps ?? 0) + 1,
		lapses: (state?.lapses ?? 0) + (state && rating === 1 && elapsed >= 1 ? 1 : 0),
	};
}

/** When `state` is due at `retention`. After an Again the next review waits
 *  at least `minAfterAgainDays` (a relearning session needs a night). */
export function dueAt(state: FsrsState, retention: number, lastRating?: FsrsRating, minAfterAgainDays = 1, weights?: FsrsWeights): number {
	const days = intervalDays(state, retention, weights);
	return state.lastReview + Math.max(days, lastRating === 1 ? minAfterAgainDays : 0) * DAY_MS;
}
