/**
 * The answer timer (owner, 2026-11-12): the ACTIVE time a learner spends on
 * a pending question — started the first time the question is shown,
 * stopped only by the learner's own Pause (paused time never counts), and
 * reset to zero on demand. The whole seconds ride the answer as
 * `elapsedSeconds` (dismissals included) and reach the tutor through
 * compactAnswerForModel.
 *
 * Pure state + persistence shapes; the dock's hook owns the clock and the
 * browser storage. `runningSince` is a wall-clock timestamp while running,
 * null while paused.
 */

export interface AnswerTimerState {
	/** Active time banked before the current running stretch. */
	elapsedMs: number;
	/** When the current running stretch began; null while paused. */
	runningSince: number | null;
}

/** The persisted snapshot (browser storage, keyed by question key). Restoring
 *  never counts the time the page was closed: a running timer resumes from
 *  the banked total at restore time. */
export interface StoredAnswerTimer {
	elapsedMs: number;
	paused: boolean;
	updatedAt: number;
}

export const ANSWER_TIMER_KEY_PREFIX = "lh:answer-timer:";
/** Snapshots of questions never seen again (answered, or abandoned) are
 *  pruned after a week. */
export const ANSWER_TIMER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Keyed by the pending question's key (PendingQuestion.key): the
 *  toolCallId, or the occurrence triple when a call id repeats. */
export const answerTimerKey = (questionKey: string): string => ANSWER_TIMER_KEY_PREFIX + questionKey;

export const startAnswerTimer = (now: number): AnswerTimerState => ({ elapsedMs: 0, runningSince: now });

export function answerTimerElapsedMs(s: AnswerTimerState, now: number): number {
	return s.elapsedMs + (s.runningSince === null ? 0 : Math.max(0, now - s.runningSince));
}

/** Whole seconds of active time — what the answer carries and the dock shows. */
export const answerTimerSeconds = (s: AnswerTimerState, now: number): number =>
	Math.floor(answerTimerElapsedMs(s, now) / 1000);

export function pauseAnswerTimer(s: AnswerTimerState, now: number): AnswerTimerState {
	if (s.runningSince === null) return s;
	return { elapsedMs: answerTimerElapsedMs(s, now), runningSince: null };
}

export function resumeAnswerTimer(s: AnswerTimerState, now: number): AnswerTimerState {
	if (s.runningSince !== null) return s;
	return { elapsedMs: s.elapsedMs, runningSince: now };
}

/** Back to zero; a running timer keeps running, a paused one stays paused. */
export function resetAnswerTimer(s: AnswerTimerState, now: number): AnswerTimerState {
	return { elapsedMs: 0, runningSince: s.runningSince === null ? null : now };
}

export function snapshotAnswerTimer(s: AnswerTimerState, now: number): StoredAnswerTimer {
	return { elapsedMs: answerTimerElapsedMs(s, now), paused: s.runningSince === null, updatedAt: now };
}

export function restoreAnswerTimer(stored: StoredAnswerTimer, now: number): AnswerTimerState {
	return { elapsedMs: stored.elapsedMs, runningSince: stored.paused ? null : now };
}

/** Parse a stored snapshot defensively (foreign or corrupted storage). */
export function parseStoredAnswerTimer(raw: unknown): StoredAnswerTimer | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.elapsedMs !== "number" || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) return undefined;
	if (typeof r.paused !== "boolean") return undefined;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return undefined;
	return { elapsedMs: r.elapsedMs, paused: r.paused, updatedAt: r.updatedAt };
}

/** m:ss, or h:mm:ss from an hour on. */
export function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
