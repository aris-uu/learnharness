/**
 * The FSRS-6 memory model, reduced to what tutor-graded review needs: a
 * stability/difficulty state per item, the forgetting curve, and the update
 * on a rating. Adapted from ts-fsrs 5.2.3 (FSRS-6, MIT, Open Spaced
 * Repetition) via plugins/flashcards/src/scheduler.cjs; see
 * plugins/flashcards/FSRS-LICENSE.txt. Same default parameters.
 *
 * Deliberately dropped from the flashcard scheduler: minute learning steps
 * and study-day boundaries. A review here is a tutor session, not a card
 * flip, so time is continuous (fractional days) and "same day" means under
 * 24 hours since the last review.
 */

export const FSRS_W: readonly number[] = Object.freeze([
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
	0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
	1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);

const W = FSRS_W;
const DAY_MS = 86_400_000;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const round8 = (v: number) => +v.toFixed(8);
const DECAY = -W[20]!;
const FACTOR = round8(Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1);
const MIN_S = 0.001;
const MAX_S = 36_500;

/** Again, Hard, Good, Easy. */
export type FsrsRating = 1 | 2 | 3 | 4;

export interface FsrsState {
	/** Days until recall probability falls to 90%. */
	stability: number;
	/** 1 (easy) to 10 (hard). */
	difficulty: number;
	/** Epoch ms of the last rated review. */
	lastReview: number;
	reps: number;
	lapses: number;
}

const initDifficulty = (rating: FsrsRating) => round8(W[4]! - Math.exp((rating - 1) * W[5]!) + 1);

function nextDifficulty(difficulty: number, rating: FsrsRating): number {
	const delta = round8(-W[6]! * (rating - 3) * (10 - difficulty) / 9);
	return clamp(round8(W[7]! * initDifficulty(4) + (1 - W[7]!) * (difficulty + delta)), 1, 10);
}

/** Same-day re-review (FSRS-6 short-term stability). */
function shortStability(stability: number, rating: FsrsRating): number {
	const increase = Math.pow(stability, -W[19]!) * Math.exp(W[17]! * (rating - 3 + W[18]!));
	return round8(clamp(stability * (rating >= 3 ? Math.max(increase, 1) : increase), MIN_S, MAX_S));
}

function reviewStability(state: FsrsState, rating: FsrsRating, elapsedDays: number): number {
	const { difficulty: d, stability: s } = state;
	const r = retrievability(elapsedDays, s);
	if (rating === 1) {
		const forgotten = round8(clamp(W[11]! * Math.pow(d, -W[12]!) *
			(Math.pow(s + 1, W[13]!) - 1) * Math.exp((1 - r) * W[14]!), MIN_S, MAX_S));
		return clamp(round8(s / Math.exp(W[17]! * W[18]!)), MIN_S, forgotten);
	}
	const hard = rating === 2 ? W[15]! : 1;
	const easy = rating === 4 ? W[16]! : 1;
	return round8(clamp(s * (1 + Math.exp(W[8]!) * (11 - d) * Math.pow(s, -W[9]!) *
		(Math.exp((1 - r) * W[10]!) - 1) * hard * easy), MIN_S, MAX_S));
}

/** The forgetting curve: recall probability after `elapsedDays` at stability `stability`. */
export function retrievability(elapsedDays: number, stability: number): number {
	if (!(stability > 0)) return 0;
	return round8(Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY));
}

/** Days after a review until recall probability falls to `retention`. */
export function intervalDays(stability: number, retention: number): number {
	if (!(retention > 0 && retention < 1)) throw new RangeError("retention must be in (0, 1)");
	return stability * (Math.pow(retention, 1 / DECAY) - 1) / FACTOR;
}

/** Recall probability of `state` at `nowMs`. */
export function retrievabilityAt(state: FsrsState, nowMs: number): number {
	return retrievability((nowMs - state.lastReview) / DAY_MS, state.stability);
}

/** The state after rating a review at `atMs`; `null` state = first review. */
export function rateFsrs(state: FsrsState | null, rating: FsrsRating, atMs: number): FsrsState {
	if (![1, 2, 3, 4].includes(rating)) throw new RangeError("rating must be 1–4");
	if (!Number.isFinite(atMs)) throw new RangeError("atMs must be a finite timestamp");
	if (state === null) {
		return { stability: Math.max(W[rating - 1]!, 0.1), difficulty: clamp(initDifficulty(rating), 1, 10), lastReview: atMs, reps: 1, lapses: 0 };
	}
	const elapsed = Math.max(0, (atMs - state.lastReview) / DAY_MS);
	const stability = elapsed < 1 ? shortStability(state.stability, rating) : reviewStability(state, rating, elapsed);
	return {
		stability,
		difficulty: nextDifficulty(state.difficulty, rating),
		lastReview: atMs,
		reps: state.reps + 1,
		lapses: state.lapses + (rating === 1 && elapsed >= 1 ? 1 : 0),
	};
}

/** When `state` is due at `retention`. After an Again the next review waits
 *  at least `minAfterAgainDays` (a relearning session needs a night). */
export function dueAt(state: FsrsState, retention: number, lastRating?: FsrsRating, minAfterAgainDays = 1): number {
	const days = intervalDays(state.stability, retention);
	return state.lastReview + Math.max(days, lastRating === 1 ? minAfterAgainDays : 0) * DAY_MS;
}
