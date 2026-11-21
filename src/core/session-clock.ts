/**
 * Time-boxed sessions (2026-11-20, docs/timeboxed-sessions-plan.md): one
 * chat is one sitting with a budget chosen up front. The clock counts
 * ACTIVE minutes only, by the same rule as tools/lh-analysis: gaps between
 * messages under 20 minutes count, longer gaps are breaks. Pure; derived
 * from the record on each read, nothing stored.
 */

export const TIMEBOX_OPTIONS = [25, 45, 60, 90] as const;
export const TIMEBOX_GAP_MIN = 20;
/** From this share of the budget the tutor stops opening new nodes. */
export const TIMEBOX_CONVERGE_AT = 0.85;

/** One extension per sitting, in minutes. */
export const TIMEBOX_EXTEND_MIN = 15;
/** A sitting reopened after this long opens with a recap retrieval. */
export const TIMEBOX_RESUME_HOURS = 4;

export type TimeboxPhase = "teach" | "converge" | "close" | "closed";

export interface SessionGoal {
	id: string;
	/** "Prove …", "Compute …", "State and use …": checkable. */
	text: string;
	/** Plan nodes that serve it. */
	nodeIds: string[];
	status: "open" | "met" | "partial" | "unmet";
}

/** The sitting's state beyond its budget (ChatSettings.timebox). */
export interface TimeboxState {
	extendedMin?: number;
	/** [start, end] in ms; end null while the break runs. */
	breaks?: Array<[number, number | null]>;
	goals?: SessionGoal[];
	closedAt?: string;
	handoff?: string;
	/** The chat this sitting continues. */
	continuesFrom?: string;
}

export interface SessionClock {
	usedMin: number;
	budgetMin: number;
	leftMin: number;
	phase: TimeboxPhase;
	onBreak?: boolean;
}

export const isTimeboxOption = (value: unknown): value is number =>
	typeof value === "number" && (TIMEBOX_OPTIONS as readonly number[]).includes(value);

function stamp(message: unknown): number | null {
	const raw = (message as { timestamp?: unknown } | null)?.timestamp;
	const n = typeof raw === "string" ? Number(raw) : raw;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Active minutes over the messages, plus the open stretch up to `nowMs` when it is under the gap. */
export function activeMinutes(messages: readonly unknown[], nowMs?: number, gapMin = TIMEBOX_GAP_MIN, breaks: TimeboxState["breaks"] = []): number {
	const ts = messages.map(stamp).filter((t): t is number => t !== null).sort((a, b) => a - b);
	if (nowMs !== undefined && ts.length > 0 && nowMs > ts[ts.length - 1]!) ts.push(nowMs);
	const end = nowMs ?? ts[ts.length - 1] ?? 0;
	let total = 0;
	for (let i = 1; i < ts.length; i++) {
		const a = ts[i - 1]!, b = ts[i]!;
		if ((b - a) / 60_000 >= gapMin) continue;
		// Explicit breaks never count, even when shorter than the gap rule.
		let overlap = 0;
		for (const [s, e] of breaks) overlap += Math.max(0, Math.min(b, e ?? end) - Math.max(a, s));
		total += (b - a - overlap) / 60_000;
	}
	return total;
}

export function sessionClock(messages: readonly unknown[], budgetMin: number, nowMs: number, state: TimeboxState = {}): SessionClock {
	const budget = budgetMin + (state.extendedMin ?? 0);
	const usedMin = Math.round(activeMinutes(messages, nowMs, TIMEBOX_GAP_MIN, state.breaks));
	const phase: TimeboxPhase = state.closedAt ? "closed" : usedMin >= budget ? "close" : usedMin >= budget * TIMEBOX_CONVERGE_AT ? "converge" : "teach";
	const onBreak = state.breaks?.some(([, e]) => e === null) ?? false;
	return { usedMin, budgetMin: budget, leftMin: Math.max(0, budget - usedMin), phase, ...(onBreak ? { onBreak } : {}) };
}

/** Hours since the record's last message when it is past the resume line, else null. */
export function resumedAfterHours(messages: readonly unknown[], nowMs: number): number | null {
	const ts = messages.map(stamp).filter((t): t is number => t !== null).sort((a, b) => a - b);
	if (ts.length === 0) return null;
	// The learner's new message may already be in the record: measure the gap before it.
	let last = ts[ts.length - 1]!;
	if (nowMs - last < 5 * 60_000) { if (ts.length < 2) return null; nowMs = last; last = ts[ts.length - 2]!; }
	const hours = (nowMs - last) / 3_600_000;
	return hours >= TIMEBOX_RESUME_HOURS ? Math.round(hours) : null;
}

/** How many new math-mode nodes a budget fits (≈ 3 per hour of teaching), standard ≈ 8. */
export function budgetNodeLimit(budgetMin: number, math: boolean): number {
	const teachMin = budgetMin * 0.75;
	return Math.max(1, Math.ceil(teachMin / (math ? 20 : 7.5)));
}

/** The doctrine appended to a time-boxed session's prompt. */
export function timeboxDoctrine(budgetMin: number, kind: "teach" | "review" | "consolidate" = "teach", resumedHours: number | null = null): string {
	const resume = resumedHours !== null
		? `

**This sitting was reopened after about ${resumedHours} hours.** Before anything new, open with a 3-minute recap retrieval: one short written question on what this sitting already covered, without restating it first. Then continue toward the goals.`
		: "";
	if (kind !== "teach") {
		const items = kind === "consolidate" ? Math.max(1, Math.floor(budgetMin / 12)) : Math.max(1, Math.floor(budgetMin / 3));
		return `# Time box: this sitting is ${budgetMin} active minutes

Pick about ${items} items with pick_items (not the default), so the sitting fits. Each learner answer carries \`clock: {usedMin, leftMin, phase}\`. At phase "converge" start no new item; at "close" finish the current item.

**End every sitting with \`close_session\`**, when the items are done or the time is up, whichever comes first: write the closing summary, then call \`close_session\` with \`verdicts: []\` and a hand-off (per item: what holds, what is fragile, when it is due; anything to teach next). A closing summary in prose without the call leaves the sitting open; the learner then has no "Continue" card.${resume}`;
	}
	return [
		`# Time box: this session is one sitting of ${budgetMin} active minutes`,
		"The learner chose this budget so the session is finished in one sitting, not left midway and resumed after the material is forgotten. Each learner answer carries `clock: {usedMin, leftMin, phase}`.",
		`- **Size the goal to the budget.** After the probe, state 1–3 goals the sitting can actually reach (about one new math-mode node per 20 minutes, after a probe of at most ~15% of the budget), and put the rest on a "later" list. Do not widen the goal; insert only a missing prerequisite on the current path.`,
		`- **phase "converge"** (≥ ${Math.round(TIMEBOX_CONVERGE_AT * 100)}% used): finish the current node; open no new node.`,
		"- **phase \"close\"** (budget used): at the next natural boundary, never mid-answer, close the sitting: (1) one blank-page retrieval per goal, written from scratch; (2) a verdict per goal: met / partial / not met, from the evidence; (3) a short hand-off: what holds, what is fragile, what the next sitting should start with. Keep the close even when time is short; shorten teaching instead. If the learner asks to continue past the budget, allow it once (about 15 minutes) and say so.",
		"- **Goals and close are tools.** Right after `plan_init`, call `set_goals` with the 1–3 goals and the plan nodes serving each. At the close, call `close_session` with a verdict per goal and the hand-off; it refuses \"met\" without credited evidence on that goal's nodes in this session.",
		"- **The sitting is only closed by `close_session`.** Call it whenever the sitting ends: the budget is used, the goals are done early, or the learner wants to stop. A goodbye or summary in prose without the call leaves the session open and the learner without a \"Continue\" card. After it succeeds, say one short line and stop; the learner continues in a new session seeded with your hand-off.",
		"- If the last few answers show piling hints, bare \"I don't know\"s or shrinking answers, offer a short break or an early close. Never force it." +
			(budgetMin >= 90 ? " For a budget this long, suggest a 10-minute break around minute 50 (the learner presses Break; the clock pauses)." : ""),
	].join("\n") + resume;
}
