/**
 * Memory items: one per math-mode plan node that has evidence, each with a
 * forgetting curve. Everything here is DERIVED from the global evidence
 * ledger (plus, from phase 2, a review log) on every read: nothing is
 * stored, so there is no backfill, no drift and no state to repair. New
 * math-mode evidence changes an item's seed automatically.
 *
 * Design: docs/retention-mode-plan.md (§3–§5).
 */
import { MATH_DIMENSIONS, nodeStatus, type EvidenceRecord, type MathDimension, type MathNodeStatus } from "../math-evidence.ts";
import { daysTo90, dueAt, rateFsrs, retrievabilityAt, type FsrsRating, type FsrsState, type FsrsWeights, type TrainingReview } from "./fsrs.ts";

/** Recall probability the schedule aims to keep each item above. Lower
 *  than flashcards' 0.90: a fresh tutor-made question is harder than a
 *  fixed card, and each review costs a model turn. */
export const DEFAULT_DESIRED_RETENTION = 0.85;
/** Anki's "mature" line (docs/consolidation-sessions-plan.md): only mature
 *  items are reviewed; younger ones go to consolidation sittings. Measured as
 *  days until recall falls to 90% (daysTo90), which is what FSRS-6 stability
 *  meant; FSRS-7's own stability field no longer does (docs/fsrs7-plan.md §2). */
export const MATURE_STABILITY_DAYS = 21;
export type MemoryStage = "learning" | "mature";
export const memoryStage = (item: { state?: FsrsState | null; daysTo90?: number | null }, weights?: FsrsWeights): MemoryStage =>
	// A snapshot already carries daysTo90, read with the weights it was built with.
	item.state && (typeof item.daysTo90 === "number" ? item.daysTo90 : daysTo90(item.state, weights)) >= MATURE_STABILITY_DAYS ? "mature" : "learning";

/** Plan node ids are per-chat slugs, so an item is keyed by both. */
export const memoryItemId = (chatId: string, nodeId: string) => `${chatId}#${nodeId}`;

/** One scheduling event. Seeds are derived from evidence; reviews come from
 *  review sessions (phase 2). Only seed and review move the schedule. */
export interface MemoryEvent {
	itemId: string;
	at: string;
	/** seed and review move the schedule; retry, followup and check are logged only. */
	kind: "seed" | "review" | "retry" | "followup" | "check";
	rating: FsrsRating;
	/** The sitting it happened in (review events carry it; seeds do not). */
	chatId?: string;
	/** The rating as graded, when a failed follow-up in the same sitting capped it (capByFollowUps). */
	cappedFrom?: FsrsRating;
}

/**
 * THE EASY RUNG DOES NOT MATURE AN ITEM ALONE (owner, 2026-11-21): a first
 * attempt is asked on the easiest rung, so a clean statement followed by a
 * failed harder rung in the same sitting (a follow-up rated Again or Hard)
 * lowers that first attempt one step: Easy → Good, Good → Hard. Hard and
 * Again stay. Pure; applied on every replay, so the stored log is unchanged.
 */
export function capByFollowUps(events: readonly MemoryEvent[]): MemoryEvent[] {
	return events.map((event) => {
		if (event.kind !== "review" || event.rating < 3 || !event.chatId) return event;
		const slipped = events.some((f) => f.kind === "followup" && f.chatId === event.chatId && f.itemId === event.itemId && ms(f.at) >= ms(event.at) && f.rating <= 2);
		return slipped ? { ...event, rating: (event.rating - 1) as FsrsRating, cappedFrom: event.rating } : event;
	});
}

export type MemoryItemStatus =
	/** Has a schedule. */
	| "scheduled"
	/** Only `assumed` evidence: never shown, so verify once before scheduling. */
	| "unverified";

export interface MemoryItem {
	id: string;
	chatId: string;
	nodeId: string;
	title: string;
	summary?: string;
	status: MemoryItemStatus;
	/** The node's status in its own session's evidence. */
	sessionStatus: MathNodeStatus;
	/** Dimensions credited (correct/correct_slow, at most one hint) in that session. */
	credited: MathDimension[];
	evidenceCount: number;
	/** The rating the teaching session's evidence seeds the curve with. */
	seedRating?: FsrsRating;
	/** Every schedule-moving event, oldest first (seed first). */
	events: MemoryEvent[];
	state?: FsrsState;
}

export interface MemoryItemSnapshot extends MemoryItem {
	/** Days from the last review until recall falls to 90% (the shown "stability"); null without a schedule. */
	daysTo90: number | null;
	/** Recall probability now (0 for unverified items, which are due now). */
	retrievability: number;
	/** ISO time the item falls below the desired retention. */
	dueAt: string;
	/** Due: recall probability at or below the desired retention. */
	due: boolean;
	/** Solid in its session, but its recall probability has fallen below the desired retention. */
	stale: boolean;
}

const credits = (e: EvidenceRecord) => (e.outcome === "correct" || e.outcome === "correct_slow") && e.hints <= 1;
const ms = (iso: string) => Date.parse(iso);
/** Credit within this span of a node's first attempt counts as encoding, not retention. */
export const ENCODING_WINDOW_MS = 12 * 3_600_000;

/**
 * The seed a node's teaching-session evidence implies (plan §4):
 * solid with an unhinted, non-slow K and deeper dimension, credited past
 * the teaching session's encoding window → Good; solid otherwise → Hard; in progress → Again (at the last attempt); assumed only →
 * unverified (no seed); skipped → not an item.
 */
export function seedFor(records: readonly EvidenceRecord[]): { status: MemoryItemStatus; rating?: FsrsRating; at?: string } | null {
	if (records.length === 0) return null;
	const status = nodeStatus(records[0]!.nodeId, records);
	if (status === "skipped" || status === "none") return null;
	if (status === "conditional") return { status: "unverified" };
	if (status === "in_progress") {
		const attempts = records.filter((e) => e.outcome !== "assumed" && e.outcome !== "learner_override");
		if (attempts.length === 0) return { status: "unverified" };
		return { status: "scheduled", rating: 1, at: attempts.at(-1)!.recordedAt };
	}
	const credited = records.filter(credits);
	const clean = (dims: readonly MathDimension[]) => credited.some((e) => dims.includes(e.dimension) && e.outcome === "correct" && e.hints === 0);
	// ENCODING IS NOT RETENTION (owner, 2026-11-18, after the first review):
	// credit earned only while the node was being taught (every credited
	// record within ENCODING_WINDOW_MS of the first attempt) shows it was
	// understood, not that it survives a delay. Such a seed is capped at
	// Hard, so the first real retrieval comes after about two days instead
	// of a week. Credit from a later return (a re-test hours or days on)
	// keeps the full seed.
	const firstAttempt = Math.min(...records.filter((e) => e.outcome !== "assumed" && e.outcome !== "learner_override").map((e) => ms(e.recordedAt)));
	const encodingOnly = credited.every((e) => ms(e.recordedAt) - firstAttempt < ENCODING_WINDOW_MS);
	const rating: FsrsRating = clean(["K"]) && clean(["U", "S", "P"]) && !encodingOnly ? 3 : 2;
	return { status: "scheduled", rating, at: credited.at(-1)!.recordedAt };
}

/** Replay events into an FSRS state; only seeds and first attempts move the schedule. */
export function replay(events: readonly MemoryEvent[], weights?: FsrsWeights): FsrsState | undefined {
	let state: FsrsState | null = null;
	for (const event of [...events].sort((a, b) => ms(a.at) - ms(b.at))) {
		if (event.kind !== "seed" && event.kind !== "review") continue;
		const at = ms(event.at);
		if (!Number.isFinite(at)) continue;
		state = rateFsrs(state, event.rating, at, weights);
	}
	return state ?? undefined;
}

/** Every memory item the evidence implies, with `reviews` (phase 2) replayed on top. */
export function memoryItems(records: readonly EvidenceRecord[], reviews: readonly MemoryEvent[] = [], weights?: FsrsWeights): MemoryItem[] {
	const groups = new Map<string, EvidenceRecord[]>();
	for (const record of records) {
		const id = memoryItemId(record.chatId, record.nodeId);
		const list = groups.get(id) ?? [];
		list.push(record);
		groups.set(id, list);
	}
	const reviewsBy = new Map<string, MemoryEvent[]>();
	for (const review of reviews) {
		const list = reviewsBy.get(review.itemId) ?? [];
		list.push(review);
		reviewsBy.set(review.itemId, list);
	}
	const items: MemoryItem[] = [];
	for (const [id, list] of groups) {
		const seed = seedFor(list);
		if (!seed) continue;
		const latest = list.at(-1)!;
		const named = [...list].reverse().find((e) => e.nodeTitle && e.nodeTitle !== e.nodeId) ?? latest;
		const events: MemoryEvent[] = capByFollowUps([
			...(seed.rating && seed.at ? [{ itemId: id, at: seed.at, kind: "seed" as const, rating: seed.rating }] : []),
			...(reviewsBy.get(id) ?? []),
		].sort((a, b) => ms(a.at) - ms(b.at)));
		const state = replay(events, weights);
		items.push({
			id,
			chatId: latest.chatId,
			nodeId: latest.nodeId,
			title: named.nodeTitle,
			...(named.nodeSummary ? { summary: named.nodeSummary } : {}),
			// A review on an unverified item gives it a schedule.
			status: state ? "scheduled" : seed.status,
			sessionStatus: nodeStatus(latest.nodeId, list),
			credited: MATH_DIMENSIONS.filter((d) => list.some((e) => e.dimension === d && credits(e))),
			evidenceCount: list.length,
			...(seed.rating ? { seedRating: seed.rating } : {}),
			events,
			...(state ? { state } : {}),
		});
	}
	return items;
}

/** An item's curve read at `nowMs`. */
export function snapshotItem(item: MemoryItem, nowMs: number, retention = DEFAULT_DESIRED_RETENTION, weights?: FsrsWeights): MemoryItemSnapshot {
	if (!item.state) {
		return { ...item, daysTo90: null, retrievability: 0, dueAt: new Date(nowMs).toISOString(), due: true, stale: false };
	}
	const r = retrievabilityAt(item.state, nowMs, weights);
	const lastRating = [...item.events].reverse().find((e) => e.kind === "seed" || e.kind === "review")?.rating;
	const due = dueAt(item.state, retention, lastRating, undefined, weights);
	return {
		...item,
		daysTo90: daysTo90(item.state, weights),
		retrievability: r,
		dueAt: new Date(due).toISOString(),
		due: nowMs >= due,
		stale: item.sessionStatus === "solid" && r < retention,
	};
}

/** All items read at `nowMs`, most forgotten first. */
export function memorySnapshot(records: readonly EvidenceRecord[], nowMs: number, options: { reviews?: readonly MemoryEvent[]; retention?: number; weights?: FsrsWeights } = {}): MemoryItemSnapshot[] {
	return memoryItems(records, options.reviews, options.weights)
		.map((item) => snapshotItem(item, nowMs, options.retention, options.weights))
		.sort((a, b) => a.retrievability - b.retrievability || a.title.localeCompare(b.title));
}

/** Points of an item's recall curve from its first event to `untilMs`, for
 *  sparklines: `[epochMs, recall]`, with a vertical drop/rise at each review. */
export function curvePoints(item: MemoryItem, untilMs: number, samplesPerSegment = 24, weights?: FsrsWeights): Array<[number, number]> {
	const moving = item.events.filter((e) => e.kind === "seed" || e.kind === "review").sort((a, b) => ms(a.at) - ms(b.at));
	const points: Array<[number, number]> = [];
	let state: FsrsState | null = null;
	for (let i = 0; i < moving.length; i++) {
		const at = ms(moving[i]!.at);
		if (state) points.push([at, retrievabilityAt(state, at, weights)]);
		state = rateFsrs(state, moving[i]!.rating, at, weights);
		const end = i + 1 < moving.length ? ms(moving[i + 1]!.at) : untilMs;
		for (let k = 0; k <= samplesPerSegment; k++) {
			const t = at + (Math.max(end, at) - at) * (k / samplesPerSegment);
			points.push([t, retrievabilityAt(state, t, weights)]);
		}
	}
	return points;
}

/** FSRS training items from memory items (docs/fsrs7-plan.md §3): each
 *  item's seed and review events, oldest first (retries and follow-ups never
 *  move the schedule, so they are not training data); every prefix of two or
 *  more events is one item. */
export function trainingItems(items: readonly MemoryItem[]): TrainingReview[][] {
	const out: TrainingReview[][] = [];
	for (const item of items) {
		const moving = item.events
			.filter((e) => (e.kind === "seed" || e.kind === "review") && Number.isFinite(ms(e.at)))
			.sort((a, b) => ms(a.at) - ms(b.at));
		const reviews = moving.map((e, i): TrainingReview => ({
			rating: e.rating,
			deltaT: i === 0 ? 0 : Math.max(0, (ms(e.at) - ms(moving[i - 1]!.at)) / 86_400_000),
		}));
		for (let k = 2; k <= reviews.length; k++) out.push(reviews.slice(0, k));
	}
	return out;
}

/** One row of the memory view (server/memory.ts builds it, the page renders it). */
export interface MemoryViewItem extends MemoryItemSnapshot {
	sessionTitle: string;
	/** Recall curve from the first event to two weeks ahead: [epochMs, recall]. */
	curve: Array<[number, number]>;
}

export interface MemoryView {
	now: number;
	retention: number;
	items: MemoryViewItem[];
}
