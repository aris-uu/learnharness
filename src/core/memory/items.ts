/**
 * Memory items: one per global math concept with attempts, each with a
 * forgetting curve. Everything here is DERIVED from the attempt log
 * (core/math-concepts.ts) on every read: nothing is stored, so there is no
 * backfill, no drift and no state to repair.
 *
 * THE SCHEDULE RULE (docs/global-concepts-plan.md §2.2), the same for every
 * session kind:
 *   1. A concept with no schedule yet: the attempts of its first sitting
 *      seed it (seedFor: solid past the encoding window → Good, solid
 *      otherwise → Hard, in progress → Again). A review or consolidation
 *      sitting on an unscheduled concept gives it a schedule from its first
 *      graded attempt.
 *   2. A concept with a schedule: in every later sitting, the FIRST graded
 *      attempt on it moves the schedule, whatever the session kind (a probe
 *      answer in a teach session is that concept's review). Later attempts
 *      in that sitting are logged only.
 *   3. Optional implicit credit along prerequisite edges (§4 R7).
 *
 * Design: docs/retention-mode-plan.md §3–§5, docs/global-concepts-plan.md.
 */
import { MATH_DIMENSIONS, nodeStatus, type MathDimension, type MathEvidence, type MathNodeStatus } from "../math-evidence.ts";
import { prerequisitesOf, type Attempt, type Concept, type ConceptGraph, type ConceptKind, type MathStore, type UnverifiedNote } from "../math-concepts.ts";
import { daysTo90, dueAt, rateFsrs, retrievabilityAt, type FsrsRating, type FsrsState, type FsrsWeights, type TrainingReview } from "./fsrs.ts";

/** Recall probability the schedule aims to keep each item above. Lower
 *  than flashcards' 0.90: a fresh tutor-made question is harder than a
 *  fixed card, and each review costs a model turn. */
export const DEFAULT_DESIRED_RETENTION = 0.85;
/** Anki's "mature" line (docs/consolidation-sessions-plan.md): only mature
 *  items are reviewed; younger ones go to consolidation sittings. Measured as
 *  days until recall falls to 90% (daysTo90). */
export const MATURE_STABILITY_DAYS = 21;
/** learning: young or never verified. mature: daysTo90 ≥ 21. relearning: was
 *  mature once and has fallen back after a lapse (consolidation takes it). */
export type MemoryStage = "learning" | "mature" | "relearning";

export function memoryStage(item: { state?: FsrsState | null; daysTo90?: number | null; everMature?: boolean }, weights?: FsrsWeights): MemoryStage {
	const days = item.state ? (typeof item.daysTo90 === "number" ? item.daysTo90 : daysTo90(item.state, weights)) : null;
	if (days !== null && days >= MATURE_STABILITY_DAYS) return "mature";
	return item.everMature ? "relearning" : "learning";
}

/** Implicit credit (R7): how close to due a prerequisite must be to get it. */
export const IMPLICIT_CREDIT_DUE_WITHIN_DAYS = 3;

export interface MemoryOptions {
	weights?: FsrsWeights;
	/** Setting `implicitCredit` (default off): a clean U/S/P review of X gives due direct prerequisites a Hard. */
	implicitCredit?: boolean;
	retention?: number;
}

/** One scheduling event. seed, review and implicit move the schedule; retry, followup and check are logged only. */
export interface MemoryEvent {
	itemId: string;
	at: string;
	kind: "seed" | "review" | "retry" | "followup" | "check" | "implicit";
	rating: FsrsRating;
	/** The sitting it happened in (seeds carry their teaching sitting). */
	chatId?: string;
	/** The attempt's dimension (seeds carry none). */
	dimension?: MathDimension;
	/** The attempt behind it. */
	attemptId?: string;
	/** The rating as graded, when a failed follow-up in the same sitting capped it (capByFollowUps). */
	cappedFrom?: FsrsRating;
	/** For implicit: the concept whose review gave it. */
	via?: string;
	/** For check events: which check (repair, close, contrast). */
	check?: string;
	/** Why the rating was capped below what was graded (cappedFrom set). */
	cappedBy?: "followup" | "depth" | "contrast";
	/** The rating before the depth / contrast cap: what recall actually showed, so FSRS trains on it (the cap is policy, not memory). */
	depthFrom?: FsrsRating;
}

const ms = (iso: string) => Date.parse(iso);
const DAY_MS = 86_400_000;

/**
 * THE EASY RUNG DOES NOT MATURE AN ITEM ALONE (owner, 2026-11-21): a first
 * attempt is asked on the easiest rung, so a clean statement followed by a
 * failed harder rung in the same sitting (a follow-up rated Again or Hard)
 * lowers that first attempt one step: Easy → Good, Good → Hard.
 */
export function capByFollowUps(events: readonly MemoryEvent[]): MemoryEvent[] {
	return events.map((event) => {
		if (event.kind !== "review" || event.rating < 3 || !event.chatId) return event;
		const slipped = events.some((f) => f.kind === "followup" && f.chatId === event.chatId && f.itemId === event.itemId && ms(f.at) >= ms(event.at) && f.rating <= 2);
		return slipped ? { ...event, rating: (event.rating - 1) as FsrsRating, cappedFrom: event.rating, cappedBy: "followup" } : event;
	});
}

/**
 * DEPTH BEFORE MATURITY (owner, 2026-11-26, docs/depth-and-contrast-plan.md A1):
 * the dimensions an item must show AFTER the encoding window before a clean
 * first attempt may count as more than Hard. A statement held a week later
 * says the statement survived, not the proof or the reason.
 */
export const DEPTH_TARGET: Record<ConceptKind, readonly MathDimension[]> = {
	definition: ["K", "U"],
	fact: ["K", "U"],
	theorem: ["K", "P"],
	technique: ["K", "S"],
	example: ["S"],
};

/** Event kinds whose clean answers count as retained depth: the schedule-moving first attempt, follow-ups and close checks (not repairs, retries or contrasts). */
const depthEvidence = (e: MemoryEvent) => e.kind === "review" || e.kind === "followup" || (e.kind === "check" && e.check === "close");

/**
 * The dimensions held cleanly (Good or Easy) outside the encoding window,
 * by events up to `untilMs` (inclusive) plus any event of `chatId`.
 */
export function retainedDims(events: readonly MemoryEvent[], firstAttemptMs: number, untilMs = Infinity, chatId?: string): MathDimension[] {
	const held = new Set<MathDimension>();
	for (const e of events) {
		// The answer as graded: a cap on the schedule does not undo what the answer showed.
		if (!depthEvidence(e) || !e.dimension || (e.cappedFrom ?? e.rating) < 3) continue;
		const at = ms(e.at);
		if (at - firstAttemptMs < ENCODING_WINDOW_MS) continue;
		if (at > untilMs && (!chatId || e.chatId !== chatId)) continue;
		held.add(e.dimension);
	}
	return MATH_DIMENSIONS.filter((d) => held.has(d));
}

/** What `kind` still needs beyond `retained`. */
export const depthMissingFor = (kind: ConceptKind, retained: readonly MathDimension[]): MathDimension[] => DEPTH_TARGET[kind].filter((d) => !retained.includes(d));

/**
 * The depth cap (A2) and the contrast cap (B2), applied after capByFollowUps:
 * a Good or Easy first attempt is capped at Hard when, after its sitting, the
 * item still misses part of its depth target, or when a contrast check on it
 * failed in that sitting (a pair still being confused cannot mature).
 */
export function capByDepth(events: readonly MemoryEvent[], kind: ConceptKind, firstAttemptMs: number): MemoryEvent[] {
	return events.map((event) => {
		if (event.kind !== "review" || event.rating < 3) return event;
		const contrastFailed = !!event.chatId && events.some((c) => c.kind === "check" && c.check === "contrast" && c.chatId === event.chatId && c.rating <= 2);
		const missing = depthMissingFor(kind, retainedDims(events, firstAttemptMs, ms(event.at), event.chatId));
		if (!contrastFailed && missing.length === 0) return event;
		return { ...event, rating: 2 as FsrsRating, cappedFrom: event.cappedFrom ?? event.rating, cappedBy: contrastFailed ? "contrast" : "depth", depthFrom: event.rating };
	});
}

export type MemoryItemStatus =
	/** Has a schedule. */
	| "scheduled"
	/** No graded attempt yet: only old unverified notes, or only overrides. Verify once before scheduling. */
	| "unverified";

export interface MemoryItem {
	/** The concept id. */
	id: string;
	title: string;
	summary?: string;
	kind: ConceptKind;
	statement: string;
	scopeDraft: boolean;
	retired: boolean;
	status: MemoryItemStatus;
	/** The concept's mastery status over every attempt (solid needs K plus a deeper credited dimension). */
	mastery: MathNodeStatus;
	/** Dimensions credited (correct/correct_slow, at most one hint) anywhere. */
	credited: MathDimension[];
	/** Dimensions held cleanly after the encoding window (retainedDims), and what the kind's depth target still misses. */
	retained: MathDimension[];
	depthMissing: MathDimension[];
	evidenceCount: number;
	/** The sitting of the latest attempt, and every sitting that touched it, oldest first. */
	chatId: string;
	chatIds: string[];
	/** The rating the first sitting seeds the curve with. */
	seedRating?: FsrsRating;
	/** Every event, oldest first. */
	events: MemoryEvent[];
	state?: FsrsState;
	/** Mature at some point of its history (relearning when it fell back). */
	everMature: boolean;
}

export interface MemoryItemSnapshot extends MemoryItem {
	/** Days from the last review until recall falls to 90% (the shown "stability"); null without a schedule. */
	daysTo90: number | null;
	/** Recall probability now (0 for unverified items, which are due now). */
	retrievability: number;
	dueAt: string;
	due: boolean;
	/** Solid, but recall has fallen below the desired retention. */
	stale: boolean;
	stage: MemoryStage;
}

const credits = (e: { outcome: string; hints: number }) => (e.outcome === "correct" || e.outcome === "correct_slow") && e.hints <= 1;
/** Credit within this span of a concept's first attempt counts as encoding, not retention. */
export const ENCODING_WINDOW_MS = 12 * 3_600_000;

/** An attempt as the status rules read it (nodeStatus keys on nodeId). */
export const asEvidence = (a: Attempt): MathEvidence => ({ id: a.id, nodeId: a.conceptId, dimension: a.dimension, outcome: a.outcome, hints: a.hints, note: a.note, ...(a.habits ? { habits: a.habits } : {}) });

/**
 * The seed a concept's first teaching sitting implies (plan §4): solid with
 * an unhinted, non-slow K and deeper dimension, credited past the encoding
 * window → Good; solid otherwise → Hard; in progress → Again (at the last
 * attempt); nothing graded → unverified; skipped → none.
 */
export function seedFor(attempts: readonly Attempt[]): { status: MemoryItemStatus; rating?: FsrsRating; at?: string } | null {
	if (attempts.length === 0) return null;
	const status = nodeStatus(attempts[0]!.conceptId, attempts.map(asEvidence));
	if (status === "skipped" || status === "none") return null;
	const graded = attempts.filter((e) => e.outcome !== "learner_override");
	if (graded.length === 0) return { status: "unverified" };
	if (status === "in_progress") return { status: "scheduled", rating: 1, at: graded.at(-1)!.at };
	const credited = attempts.filter(credits);
	const clean = (dims: readonly MathDimension[]) => credited.some((e) => dims.includes(e.dimension) && e.outcome === "correct" && e.hints === 0);
	// ENCODING IS NOT RETENTION (owner, 2026-11-18): credit earned only while
	// the concept was being taught (within ENCODING_WINDOW_MS of the first
	// attempt) is capped at Hard.
	const firstAttempt = Math.min(...graded.map((e) => ms(e.at)));
	const encodingOnly = credited.every((e) => ms(e.at) - firstAttempt < ENCODING_WINDOW_MS);
	const rating: FsrsRating = clean(["K"]) && clean(["U", "S", "P"]) && !encodingOnly ? 3 : 2;
	return { status: "scheduled", rating, at: credited.at(-1)!.at };
}

const moves = (e: MemoryEvent, implicit: boolean) => e.kind === "seed" || e.kind === "review" || (implicit && e.kind === "implicit");

/** Replay events into an FSRS state. */
export function replay(events: readonly MemoryEvent[], weights?: FsrsWeights, implicit = true): FsrsState | undefined {
	let state: FsrsState | null = null;
	for (const event of [...events].sort((a, b) => ms(a.at) - ms(b.at))) {
		if (!moves(event, implicit)) continue;
		const at = ms(event.at);
		if (!Number.isFinite(at)) continue;
		state = rateFsrs(state, event.rating, at, weights);
	}
	return state ?? undefined;
}

/** A concept's own events by the schedule rule (1–2), capped by failed follow-ups, then by depth and failed contrasts (when `kind` is given). */
export function conceptEvents(conceptId: string, attempts: readonly Attempt[], kind?: ConceptKind): { events: MemoryEvent[]; seed: ReturnType<typeof seedFor>; unverified: boolean } {
	const sorted = [...attempts].sort((a, b) => ms(a.at) - ms(b.at));
	const sittings: string[] = [];
	for (const a of sorted) if (!sittings.includes(a.chatId)) sittings.push(a.chatId);
	const events: MemoryEvent[] = [];
	let scheduled = false;
	let firstSeed: ReturnType<typeof seedFor> = null;
	let unverified = false;
	for (const chatId of sittings) {
		const here = sorted.filter((a) => a.chatId === chatId);
		const graded = here.filter((a) => a.role === "attempt" && a.outcome !== "learner_override" && a.rating !== undefined);
		const teaching = here.filter((a) => a.source === "teach" || a.source === "probe");
		if (!scheduled && teaching.length > 0) {
			const seed = seedFor(teaching);
			if (!firstSeed) firstSeed = seed;
			if (seed?.rating && seed.at) {
				events.push({ itemId: conceptId, at: seed.at, kind: "seed", rating: seed.rating, chatId });
				scheduled = true;
			} else if (seed?.status === "unverified") unverified = true;
		} else if (graded.length > 0) {
			const first = graded[0]!;
			events.push({ itemId: conceptId, at: first.at, kind: "review", rating: first.rating!, chatId, dimension: first.dimension, attemptId: first.id });
			scheduled = true;
		}
		for (const a of here) {
			if (a.role === "attempt" || a.rating === undefined) continue;
			events.push({ itemId: conceptId, at: a.at, kind: a.role, rating: a.rating, chatId, dimension: a.dimension, attemptId: a.id, ...(a.check ? { check: a.check } : {}) });
		}
	}
	const capped = capByFollowUps(events.sort((a, b) => ms(a.at) - ms(b.at)));
	return { events: kind && sorted.length ? capByDepth(capped, kind, ms(sorted[0]!.at)) : capped, seed: firstSeed, unverified };
}

/**
 * Implicit credit along prerequisite edges (R7, setting, default off): when a
 * clean (Good or Easy) U/S/P review moves X's schedule, each direct
 * prerequisite that already has a schedule, falls due within
 * IMPLICIT_CREDIT_DUE_WITHIN_DAYS and had no attempt in that sitting gets a
 * Hard. Derived on replay in global time order, so turning the setting off
 * removes it retroactively; never training data.
 */
function implicitEvents(graph: ConceptGraph, eventsBy: Map<string, MemoryEvent[]>, attemptedIn: Map<string, Set<string>>, options: MemoryOptions): Map<string, MemoryEvent[]> {
	const out = new Map<string, MemoryEvent[]>();
	const retention = options.retention ?? DEFAULT_DESIRED_RETENTION;
	const all = [...eventsBy.values()].flat().filter((e) => e.kind === "seed" || e.kind === "review").sort((a, b) => ms(a.at) - ms(b.at));
	const states = new Map<string, { state: FsrsState; last: FsrsRating }>();
	const apply = (id: string, rating: FsrsRating, at: number) => {
		const prev = states.get(id)?.state ?? null;
		states.set(id, { state: rateFsrs(prev, rating, at, options.weights), last: rating });
	};
	for (const event of all) {
		const at = ms(event.at);
		apply(event.itemId, event.rating, at);
		// The answer was clean even when depth capped its schedule rating.
		if (event.kind !== "review" || (event.cappedFrom ?? event.rating) < 3 || !event.dimension || event.dimension === "K") continue;
		for (const pre of prerequisitesOf(graph, event.itemId)) {
			const s = states.get(pre);
			if (!s || (event.chatId && attemptedIn.get(pre)?.has(event.chatId))) continue;
			const due = dueAt(s.state, retention, s.last, 1, options.weights);
			if (due - at > IMPLICIT_CREDIT_DUE_WITHIN_DAYS * DAY_MS) continue;
			const implicit: MemoryEvent = { itemId: pre, at: event.at, kind: "implicit", rating: 2, ...(event.chatId ? { chatId: event.chatId } : {}), via: event.itemId };
			(out.get(pre) ?? out.set(pre, []).get(pre)!).push(implicit);
			apply(pre, 2, at);
		}
	}
	return out;
}

/** Every memory item the attempt log implies. */
export function memoryItems(graph: ConceptGraph, attempts: readonly Attempt[], options: MemoryOptions & { unverified?: readonly UnverifiedNote[] } = {}): MemoryItem[] {
	const byConcept = new Map<string, Attempt[]>();
	for (const a of attempts) {
		if (a.implicit) continue;
		(byConcept.get(a.conceptId) ?? byConcept.set(a.conceptId, []).get(a.conceptId)!).push(a);
	}
	const eventsBy = new Map<string, MemoryEvent[]>();
	const meta = new Map<string, ReturnType<typeof conceptEvents>>();
	const attemptedIn = new Map<string, Set<string>>();
	for (const [id, list] of byConcept) {
		const result = conceptEvents(id, list, graph.concepts[id]?.kind ?? "fact");
		meta.set(id, result);
		eventsBy.set(id, result.events);
		attemptedIn.set(id, new Set(list.map((a) => a.chatId)));
	}
	const implicit = options.implicitCredit ? implicitEvents(graph, eventsBy, attemptedIn, options) : new Map<string, MemoryEvent[]>();
	const notesBy = new Map<string, UnverifiedNote[]>();
	for (const n of options.unverified ?? []) (notesBy.get(n.conceptId) ?? notesBy.set(n.conceptId, []).get(n.conceptId)!).push(n);

	const items: MemoryItem[] = [];
	const ids = new Set([...byConcept.keys(), ...notesBy.keys()]);
	for (const id of ids) {
		const concept: Concept | undefined = graph.concepts[id];
		const list = (byConcept.get(id) ?? []).sort((a, b) => ms(a.at) - ms(b.at));
		const m = meta.get(id);
		if (list.length && !m?.events.length && !m?.unverified && m?.seed === null) continue; // skipped only
		const events = [...(m?.events ?? []), ...(implicit.get(id) ?? [])].sort((a, b) => ms(a.at) - ms(b.at));
		// Track whether it was ever mature, replaying step by step.
		let state: FsrsState | null = null;
		let everMature = false;
		for (const e of events) {
			if (!moves(e, true)) continue;
			state = rateFsrs(state, e.rating, ms(e.at), options.weights);
			if (daysTo90(state, options.weights) >= MATURE_STABILITY_DAYS) everMature = true;
		}
		const evidence = list.map(asEvidence);
		const kind = concept?.kind ?? "fact";
		const retained = list.length ? retainedDims(m?.events ?? [], ms(list[0]!.at)) : [];
		const chatIds = [...new Set([...list.map((a) => a.chatId), ...(notesBy.get(id) ?? []).map((n) => n.chatId)])];
		items.push({
			id,
			title: concept?.title ?? id,
			...(concept?.summary ? { summary: concept.summary } : {}),
			kind: concept?.kind ?? "fact",
			statement: concept?.statement ?? "",
			scopeDraft: concept?.scopeDraft === true,
			retired: concept?.status === "retired",
			status: state ? "scheduled" : "unverified",
			mastery: nodeStatus(id, evidence),
			credited: MATH_DIMENSIONS.filter((d) => list.some((e) => e.dimension === d && credits(e))),
			retained,
			depthMissing: depthMissingFor(kind, retained),
			evidenceCount: list.length,
			chatId: list.at(-1)?.chatId ?? chatIds.at(-1) ?? concept?.createdIn ?? "",
			chatIds,
			...(m?.seed?.rating ? { seedRating: m.seed.rating } : {}),
			events,
			...(state ? { state } : {}),
			everMature,
		});
	}
	return items;
}

/** An item's curve read at `nowMs`. */
export function snapshotItem(item: MemoryItem, nowMs: number, retention = DEFAULT_DESIRED_RETENTION, weights?: FsrsWeights): MemoryItemSnapshot {
	if (!item.state) {
		return { ...item, daysTo90: null, retrievability: 0, dueAt: new Date(nowMs).toISOString(), due: !item.retired, stale: false, stage: memoryStage(item, weights) };
	}
	const r = retrievabilityAt(item.state, nowMs, weights);
	const lastRating = [...item.events].reverse().find((e) => moves(e, true))?.rating;
	const due = dueAt(item.state, retention, lastRating, undefined, weights);
	const days = daysTo90(item.state, weights);
	return {
		...item,
		daysTo90: days,
		retrievability: r,
		dueAt: new Date(due).toISOString(),
		due: !item.retired && nowMs >= due,
		stale: item.mastery === "solid" && r < retention,
		stage: memoryStage({ ...item, daysTo90: days }, weights),
	};
}

/** All items read at `nowMs`, most forgotten first. */
export function memorySnapshot(graph: ConceptGraph, attempts: readonly Attempt[], nowMs: number, options: MemoryOptions & { unverified?: readonly UnverifiedNote[] } = {}): MemoryItemSnapshot[] {
	return memoryItems(graph, attempts, options)
		.map((item) => snapshotItem(item, nowMs, options.retention, options.weights))
		.sort((a, b) => a.retrievability - b.retrievability || a.title.localeCompare(b.title));
}

/** The options a store implies: its switches plus its unverified notes. */
export const storeMemoryOptions = (store: MathStore, weights?: FsrsWeights) => ({ weights, implicitCredit: store.options().implicitCredit, unverified: store.unverified() });
/** Every item, read from a store. */
export const storeItems = (store: MathStore, weights?: FsrsWeights) => memoryItems(store.graph(), store.attempts(), storeMemoryOptions(store, weights));
/** The snapshot, read from a store. */
export const storeSnapshot = (store: MathStore, nowMs: number, weights?: FsrsWeights) => memorySnapshot(store.graph(), store.attempts(), nowMs, storeMemoryOptions(store, weights));

/** Points of an item's recall curve from its first event to `untilMs`, for
 *  sparklines: `[epochMs, recall]`, with a vertical drop/rise at each review. */
export function curvePoints(item: MemoryItem, untilMs: number, samplesPerSegment = 24, weights?: FsrsWeights): Array<[number, number]> {
	const moving = item.events.filter((e) => moves(e, true)).sort((a, b) => ms(a.at) - ms(b.at));
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

/** FSRS training items (docs/fsrs7-plan.md §3): each item's seed and review
 *  events, oldest first; retries, follow-ups, checks and implicit credit are
 *  not training data. Every prefix of two or more events is one item. */
export function trainingItems(items: readonly MemoryItem[]): TrainingReview[][] {
	const out: TrainingReview[][] = [];
	for (const item of items) {
		const moving = item.events
			.filter((e) => (e.kind === "seed" || e.kind === "review") && Number.isFinite(ms(e.at)))
			.sort((a, b) => ms(a.at) - ms(b.at));
		const reviews = moving.map((e, i): TrainingReview => ({
			rating: e.depthFrom ?? e.rating,
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
	implicitCredit: boolean;
	items: MemoryViewItem[];
}
