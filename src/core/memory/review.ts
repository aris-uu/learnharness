/**
 * Review sessions (retention mode, phase 2): the review log's record shape,
 * the grade → FSRS rating table, and the ranking of due items. The log is
 * the only stored state; schedules are replayed from it on every read
 * (items.ts). Design: docs/retention-mode-plan.md §3, §5, §6.
 */
import { MATH_DIMENSIONS, MATH_HABITS, type EvidenceRecord, type MathDimension, type MathHabit, type MathOutcome } from "../math-evidence.ts";
import type { PlanEdge } from "../contracts/plan.ts";
import type { FsrsRating } from "./fsrs.ts";
import type { MemoryEvent, MemoryItemSnapshot } from "./items.ts";

export const REVIEW_OUTCOMES = ["correct", "correct_slow", "partial", "incorrect"] as const satisfies readonly MathOutcome[];
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const RATING_LABELS: Record<FsrsRating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

/** One graded review attempt (data/memory/reviews.jsonl). Only `review`
 *  events move the schedule; a `retry` (a later attempt on the same item in
 *  the same session) is logged for the record but never replayed. */
export interface ReviewEvent extends MemoryEvent {
	kind: "review" | "retry";
	/** The record_review tool-call id. */
	id: string;
	/** The review session it happened in. */
	chatId: string;
	dimension: MathDimension;
	outcome: ReviewOutcome;
	hints: number;
	loadBearing?: boolean;
	confidence?: number;
	elapsedSeconds?: number;
	expectedSeconds?: number;
	/** What was asked, so the next review can avoid repeating it. */
	question: string;
	note: string;
	habits?: MathHabit[];
	/** Recall probability the schedule predicted just before this attempt. */
	predicted?: number;
}

/** Port for the review log (fs adapter: src/store/memory.ts). */
export interface ReviewStore {
	list(): ReviewEvent[];
	append(event: ReviewEvent): void;
	/** Drop the events made in `chatId`, and those on items it seeded. */
	removeChat(chatId: string): number;
}

export interface RatingInput {
	outcome: ReviewOutcome;
	hints: number;
	loadBearing?: boolean;
	confidence?: number;
	elapsedSeconds?: number;
	expectedSeconds?: number;
}

/**
 * The grade → rating table (plan §5). The server, not the tutor, decides the
 * rating, so the mapping is auditable and the same in every session.
 * A partial without `loadBearing: false` counts as Again: missing the step
 * that carries the argument is a failed retrieval.
 */
export function ratingFor(input: RatingInput): FsrsRating {
	const { outcome, hints } = input;
	if (outcome === "incorrect" || hints >= 2) return 1;
	if (outcome === "partial") return input.loadBearing === false ? 2 : 1;
	if (outcome === "correct_slow" || hints === 1) return 2;
	const fast = input.elapsedSeconds !== undefined && input.expectedSeconds !== undefined && input.elapsedSeconds <= input.expectedSeconds;
	return (input.confidence ?? 0) >= 90 && fast ? 4 : 3;
}

export function isReviewEvent(value: unknown): value is ReviewEvent {
	const r = value as Record<string, unknown> | null;
	const optionalNumber = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
	return !!r && typeof r === "object" &&
		typeof r.id === "string" && typeof r.itemId === "string" && typeof r.chatId === "string" &&
		typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) &&
		(r.kind === "review" || r.kind === "retry") &&
		[1, 2, 3, 4].includes(r.rating as number) &&
		(MATH_DIMENSIONS as readonly unknown[]).includes(r.dimension) &&
		(REVIEW_OUTCOMES as readonly unknown[]).includes(r.outcome) &&
		typeof r.hints === "number" && typeof r.question === "string" && typeof r.note === "string" &&
		(r.loadBearing === undefined || typeof r.loadBearing === "boolean") &&
		optionalNumber(r.confidence) && optionalNumber(r.elapsedSeconds) && optionalNumber(r.expectedSeconds) && optionalNumber(r.predicted) &&
		(r.habits === undefined || (Array.isArray(r.habits) && r.habits.every((tag) => (MATH_HABITS as readonly unknown[]).includes(tag))));
}

/** A review session's title: one per day. */
export const reviewTitle = (nowMs: number) => `Review ${new Date(nowMs).toISOString().slice(0, 10)}`;

/** A due item as `due_items` hands it to the tutor. */
export interface ReviewCandidate {
	itemId: string;
	title: string;
	summary?: string;
	session: string;
	/** Recall probability now (null: only ever assumed, never shown). */
	recall: number | null;
	daysOverdue: number;
	stability: number | null;
	credited: MathDimension[];
	/** The last few attempts on this item, newest first, so no question repeats. */
	history: Array<{ at: string; dimension: MathDimension; outcome: string; question?: string; note: string }>;
	habits: MathHabit[];
	/** Direct prerequisites (same teaching session) that are also due. */
	duePrereqs: string[];
	recentAgain: boolean;
}

const DAY_MS = 86_400_000;

/**
 * The due items, ranked for the tutor to pick from (plan §6): shown items
 * before assumed ones, prerequisites of other due items first, then lowest
 * recall, then a recent Again.
 */
export function reviewCandidates(input: {
	snapshot: readonly MemoryItemSnapshot[];
	records: readonly EvidenceRecord[];
	reviews: readonly ReviewEvent[];
	/** Each teaching session's plan edges, for prerequisites. */
	edgesOf: (chatId: string) => readonly PlanEdge[];
	sessionTitle: (chatId: string) => string;
	nowMs: number;
	limit?: number;
}): ReviewCandidate[] {
	const due = input.snapshot.filter((item) => item.due);
	const dueIds = new Set(due.map((item) => item.id));
	const candidates = due.map((item): ReviewCandidate & { prereqOfDue: boolean; unverified: boolean } => {
		const edges = input.edgesOf(item.chatId);
		const ownReviews = input.reviews.filter((r) => r.itemId === item.id);
		const evidence = input.records.filter((r) => r.chatId === item.chatId && r.nodeId === item.nodeId);
		const history = [
			...ownReviews.map((r) => ({ at: r.at, dimension: r.dimension, outcome: r.outcome, question: r.question, note: r.note })),
			...evidence.filter((r) => r.outcome !== "assumed" && r.outcome !== "learner_override").map((r) => ({ at: r.recordedAt, dimension: r.dimension, outcome: r.outcome, note: r.note })),
		].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3);
		const habits = [...new Set([...evidence.flatMap((r) => r.habits ?? []), ...ownReviews.flatMap((r) => r.habits ?? [])])];
		const lastReview = ownReviews.filter((r) => r.kind === "review").at(-1);
		const sameChat = (nodeId: string) => `${item.chatId}#${nodeId}`;
		return {
			itemId: item.id,
			title: item.title,
			...(item.summary ? { summary: item.summary } : {}),
			session: input.sessionTitle(item.chatId),
			recall: item.state ? Math.round(item.retrievability * 100) / 100 : null,
			daysOverdue: Math.max(0, Math.round(((input.nowMs - Date.parse(item.dueAt)) / DAY_MS) * 10) / 10),
			stability: item.state ? Math.round(item.state.stability * 10) / 10 : null,
			credited: item.credited,
			history,
			habits,
			duePrereqs: edges.filter((e) => e.to === item.nodeId && dueIds.has(sameChat(e.from))).map((e) => sameChat(e.from)),
			recentAgain: lastReview?.rating === 1,
			prereqOfDue: edges.some((e) => e.from === item.nodeId && dueIds.has(sameChat(e.to))),
			unverified: !item.state,
		};
	});
	candidates.sort((a, b) =>
		Number(a.unverified) - Number(b.unverified) ||
		Number(b.prereqOfDue) - Number(a.prereqOfDue) ||
		(a.recall ?? 0) - (b.recall ?? 0) ||
		Number(b.recentAgain) - Number(a.recentAgain) ||
		a.title.localeCompare(b.title));
	return candidates.slice(0, input.limit ?? 15).map(({ prereqOfDue: _p, unverified: _u, ...candidate }) => candidate);
}

/** Plan-map slugs for picked items: the node's own slug, suffixed when two
 *  picked items share one. Deterministic, so the transcript re-derives it. */
export function reviewNodeIds(itemIds: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	const used = new Set<string>();
	for (const itemId of itemIds) {
		const raw = itemId.slice(itemId.indexOf("#") + 1).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
		let slug = raw;
		for (let n = 2; used.has(slug); n++) slug = `${raw}-${n}`;
		used.add(slug);
		out.set(slug, itemId);
	}
	return out;
}
