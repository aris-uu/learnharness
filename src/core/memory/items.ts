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
import { dueAt, rateFsrs, retrievabilityAt, type FsrsRating, type FsrsState } from "./fsrs.ts";

/** Recall probability the schedule aims to keep each item above. Lower
 *  than flashcards' 0.90: a fresh tutor-made question is harder than a
 *  fixed card, and each review costs a model turn. */
export const DEFAULT_DESIRED_RETENTION = 0.85;

/** Plan node ids are per-chat slugs, so an item is keyed by both. */
export const memoryItemId = (chatId: string, nodeId: string) => `${chatId}#${nodeId}`;

/** One scheduling event. Seeds are derived from evidence; reviews come from
 *  review sessions (phase 2). Only seed and review move the schedule. */
export interface MemoryEvent {
	itemId: string;
	at: string;
	kind: "seed" | "review" | "retry";
	rating: FsrsRating;
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

/**
 * The seed a node's teaching-session evidence implies (plan §4):
 * solid with an unhinted, non-slow K and deeper dimension → Good; solid
 * otherwise → Hard; in progress → Again (at the last attempt); assumed only →
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
	const rating: FsrsRating = clean(["K"]) && clean(["U", "S", "P"]) ? 3 : 2;
	return { status: "scheduled", rating, at: credited.at(-1)!.recordedAt };
}

/** Replay events into an FSRS state; retries never move the schedule. */
export function replay(events: readonly MemoryEvent[]): FsrsState | undefined {
	let state: FsrsState | null = null;
	for (const event of [...events].sort((a, b) => ms(a.at) - ms(b.at))) {
		if (event.kind === "retry") continue;
		const at = ms(event.at);
		if (!Number.isFinite(at)) continue;
		state = rateFsrs(state, event.rating, at);
	}
	return state ?? undefined;
}

/** Every memory item the evidence implies, with `reviews` (phase 2) replayed on top. */
export function memoryItems(records: readonly EvidenceRecord[], reviews: readonly MemoryEvent[] = []): MemoryItem[] {
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
		const events: MemoryEvent[] = [
			...(seed.rating && seed.at ? [{ itemId: id, at: seed.at, kind: "seed" as const, rating: seed.rating }] : []),
			...(reviewsBy.get(id) ?? []),
		].sort((a, b) => ms(a.at) - ms(b.at));
		const state = replay(events);
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
export function snapshotItem(item: MemoryItem, nowMs: number, retention = DEFAULT_DESIRED_RETENTION): MemoryItemSnapshot {
	if (!item.state) {
		return { ...item, retrievability: 0, dueAt: new Date(nowMs).toISOString(), due: true, stale: false };
	}
	const r = retrievabilityAt(item.state, nowMs);
	const lastRating = [...item.events].reverse().find((e) => e.kind !== "retry")?.rating;
	const due = dueAt(item.state, retention, lastRating);
	return {
		...item,
		retrievability: r,
		dueAt: new Date(due).toISOString(),
		due: nowMs >= due,
		stale: item.sessionStatus === "solid" && r < retention,
	};
}

/** All items read at `nowMs`, most forgotten first. */
export function memorySnapshot(records: readonly EvidenceRecord[], nowMs: number, options: { reviews?: readonly MemoryEvent[]; retention?: number } = {}): MemoryItemSnapshot[] {
	return memoryItems(records, options.reviews)
		.map((item) => snapshotItem(item, nowMs, options.retention))
		.sort((a, b) => a.retrievability - b.retrievability || a.title.localeCompare(b.title));
}

/** Points of an item's recall curve from its first event to `untilMs`, for
 *  sparklines: `[epochMs, recall]`, with a vertical drop/rise at each review. */
export function curvePoints(item: MemoryItem, untilMs: number, samplesPerSegment = 24): Array<[number, number]> {
	const moving = item.events.filter((e) => e.kind !== "retry").sort((a, b) => ms(a.at) - ms(b.at));
	const points: Array<[number, number]> = [];
	let state: FsrsState | null = null;
	for (let i = 0; i < moving.length; i++) {
		const at = ms(moving[i]!.at);
		if (state) points.push([at, retrievabilityAt(state, at)]);
		state = rateFsrs(state, moving[i]!.rating, at);
		const end = i + 1 < moving.length ? ms(moving[i + 1]!.at) : untilMs;
		for (let k = 0; k <= samplesPerSegment; k++) {
			const t = at + (Math.max(end, at) - at) * (k / samplesPerSegment);
			points.push([t, retrievabilityAt(state, t)]);
		}
	}
	return points;
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
