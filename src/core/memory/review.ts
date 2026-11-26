/**
 * Review and consolidation sittings: the grade → FSRS rating table, the
 * ranking of due concepts, consolidation clusters and the retry queue. The
 * attempt log is the only stored state; schedules are replayed from it on
 * every read (items.ts). Design: docs/retention-mode-plan.md §5–§6,
 * docs/consolidation-sessions-plan.md §4, docs/global-concepts-plan.md.
 */
import type { MathDimension, MathHabit, MathOutcome } from "../math-evidence.ts";
import { confusablesOf, dependentsOf, prerequisitesOf, type Attempt, type ConceptGraph, type ConceptKind } from "../math-concepts.ts";
import type { FsrsRating } from "./fsrs.ts";
import { DEPTH_TARGET, type MemoryItemSnapshot, type MemoryStage } from "./items.ts";

export const REVIEW_OUTCOMES = ["correct", "correct_slow", "partial", "incorrect"] as const satisfies readonly MathOutcome[];
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const RATING_LABELS: Record<FsrsRating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

export const REVIEW_CHECKS = ["repair", "close", "contrast"] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

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
 * A partial without `loadBearing: false` counts as Again.
 */
export function ratingFor(input: RatingInput): FsrsRating {
	const { outcome, hints } = input;
	if (outcome === "incorrect" || hints >= 2) return 1;
	if (outcome === "partial") return input.loadBearing === false ? 2 : 1;
	if (outcome === "correct_slow" || hints === 1) return 2;
	const fast = input.elapsedSeconds !== undefined && input.expectedSeconds !== undefined && input.elapsedSeconds <= input.expectedSeconds;
	return (input.confidence ?? 0) >= 90 && fast ? 4 : 3;
}

/** A review session's title: dated, numbered from the second one that day. */
/** YYYY-MM-DD in the machine's own time zone (the learner's day, not UTC's). */
export function localDate(nowMs: number): string {
	const d = new Date(nowMs);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function reviewTitle(nowMs: number, existingTitles: readonly string[] = [], prefix = "Review"): string {
	const base = `${prefix} ${localDate(nowMs)}`;
	const taken = new Set(existingTitles);
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base} (${n})`)) n++;
	return `${base} (${n})`;
}

/** Which sittings take which stage: review the mature, consolidation the rest. */
export const stagesFor = (consolidate: boolean): ReadonlySet<MemoryStage> => new Set(consolidate ? ["learning", "relearning"] : ["mature"]);

/** A due concept as `due_items` hands it to the tutor. */
export interface ReviewCandidate {
	itemId: string;
	title: string;
	kind: string;
	/** What a question must test (the concept's scope). */
	statement: string;
	checks?: Partial<Record<MathDimension, string>>;
	/** The statement is a migration draft: confirm it with update_concept before asking. */
	scopeDraft?: true;
	stage: MemoryStage;
	session: string;
	recall: number | null;
	daysOverdue: number;
	stability: number | null;
	credited: MathDimension[];
	/** Dimensions held cleanly after the teaching sitting, and what the kind's depth target still misses (an item cannot mature until it is empty). */
	retained: MathDimension[];
	depthMissing: MathDimension[];
	/** The dimension to ask the schedule-moving first attempt on (firstRungFor). */
	firstRung: MathDimension;
	/** Concepts the learner easily mixes up with this one. */
	confusableWith?: string[];
	/** The last few attempts, newest first, so no question repeats. */
	history: Array<{ at: string; dimension: MathDimension; outcome: string; question?: string; note: string }>;
	habits: MathHabit[];
	/** Direct prerequisites (global graph) that are also due. */
	duePrereqs: string[];
	stale: boolean;
	recentAgain: boolean;
	firstReview: boolean;
}

const DAY_MS = 86_400_000;
const STALE_RECALL = 0.7;

/**
 * FIRST RUNG (A4): K until the statement has been retrieved once after
 * teaching (or whenever the item is stale); after that the first attempt,
 * which moves the schedule, goes to the first missing depth dimension; with
 * nothing missing, the target dimension held longest ago.
 */
export function firstRungFor(item: { kind: ConceptKind; retained: readonly MathDimension[]; depthMissing: readonly MathDimension[]; events: MemoryItemSnapshot["events"] }, stale: boolean): MathDimension {
	const target = DEPTH_TARGET[item.kind];
	const base = target.includes("K") ? "K" : target[0]!;
	if (stale || (target.includes("K") && !item.retained.includes("K"))) return base;
	if (item.depthMissing.length) return item.depthMissing[0]!;
	const lastHeld = (d: MathDimension) => Math.max(-Infinity, ...item.events.filter((e) => e.dimension === d && e.rating >= 3).map((e) => Date.parse(e.at)));
	return [...target].sort((a, b) => lastHeld(a) - lastHeld(b))[0]!;
}
/** How many harder rungs may follow a clean answer on one item in a session. */
export const MAX_FOLLOW_UPS = 2;

/**
 * The due concepts, ranked for the tutor to pick from: shown items before
 * unverified ones, prerequisites of other due items first, then lowest
 * recall, then a recent Again.
 */
export function reviewCandidates(input: {
	snapshot: readonly MemoryItemSnapshot[];
	attempts: readonly Attempt[];
	graph: ConceptGraph;
	sessionTitle: (chatId: string) => string;
	nowMs: number;
	limit?: number;
	stages?: ReadonlySet<MemoryStage>;
}): ReviewCandidate[] {
	const due = input.snapshot.filter((item) => item.due && (!input.stages || input.stages.has(item.stage)));
	const dueIds = new Set(due.map((item) => item.id));
	const candidates = due.map((item) => {
		const own = input.attempts.filter((a) => a.conceptId === item.id && !a.implicit && a.outcome !== "learner_override");
		const history = own.map((a) => ({ at: a.at, dimension: a.dimension, outcome: a.outcome, ...(a.question ? { question: a.question } : {}), note: a.note }))
			.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3);
		const habits = [...new Set(own.flatMap((a) => a.habits ?? []))];
		const lastReview = item.events.filter((e) => e.kind === "review").at(-1);
		const concept = input.graph.concepts[item.id];
		const candidate: ReviewCandidate & { prereqOfDue: boolean; unverified: boolean } = {
			itemId: item.id,
			title: item.title,
			kind: item.kind,
			statement: item.statement,
			...(concept?.checks ? { checks: concept.checks } : {}),
			...(item.scopeDraft ? { scopeDraft: true as const } : {}),
			stage: item.stage,
			session: input.sessionTitle(item.chatId),
			recall: item.state ? Math.round(item.retrievability * 100) / 100 : null,
			daysOverdue: Math.max(0, Math.round(((input.nowMs - Date.parse(item.dueAt)) / DAY_MS) * 10) / 10),
			stability: item.daysTo90 === null ? null : Math.round(item.daysTo90 * 10) / 10,
			credited: item.credited,
			retained: item.retained,
			depthMissing: item.depthMissing,
			// Every due solid item is "stale" (recall under the target); only one that has faded far opens on K again.
			firstRung: firstRungFor(item, item.state ? item.retrievability < STALE_RECALL : true),
			...(confusablesOf(input.graph, item.id).length ? { confusableWith: confusablesOf(input.graph, item.id) } : {}),
			history,
			habits,
			duePrereqs: prerequisitesOf(input.graph, item.id).filter((id) => dueIds.has(id)),
			recentAgain: lastReview?.rating === 1,
			stale: item.stale || (item.state ? item.retrievability < STALE_RECALL : false),
			firstReview: !item.events.some((e) => e.kind === "review"),
			prereqOfDue: dependentsOf(input.graph, item.id).some((id) => dueIds.has(id)),
			unverified: !item.state,
		};
		return candidate;
	});
	candidates.sort((a, b) =>
		Number(a.unverified) - Number(b.unverified) ||
		Number(b.prereqOfDue) - Number(a.prereqOfDue) ||
		(a.recall ?? 0) - (b.recall ?? 0) ||
		Number(b.recentAgain) - Number(a.recentAgain) ||
		a.title.localeCompare(b.title));
	return candidates.slice(0, input.limit ?? 15).map(({ prereqOfDue: _p, unverified: _u, ...candidate }) => candidate);
}

/** One consolidation cluster: a seed concept and the concepts studied with it. */
export interface ConsolidationCluster {
	seed: string;
	/** In study order: prerequisites first, then the seed, then confusable / same-topic neighbours. */
	itemIds: string[];
	/** Mature prerequisites pulled in as warm-ups (asked as follow-ups: they never move their schedule). */
	warmUps: string[];
	/** Confusable concepts that are not due: asked only inside a contrast question, their schedule untouched (B3). */
	contrastPartners: string[];
	/** Look-alike pairs in this cluster to ask one contrast question on; `required` when the pair was confused before. */
	contrasts: ContrastPair[];
	reasons: Record<string, string>;
}

export interface ContrastPair {
	itemId: string;
	partner: string;
	required: boolean;
}

/** Was `a` ever answered as `b`, or `b` as `a`? */
export function confusedBefore(attempts: readonly Attempt[], a: string, b: string): boolean {
	return attempts.some((x) => (x.conceptId === a && x.confusedWith === b) || (x.conceptId === b && x.confusedWith === a));
}

/** The look-alike pairs among `items` (each item with its confusables that are in `items` or in `partners`), de-duplicated. */
export function contrastPairs(graph: ConceptGraph, attempts: readonly Attempt[], items: readonly string[], partners: readonly string[] = []): ContrastPair[] {
	const pool = new Set([...items, ...partners]);
	const seen = new Set<string>();
	const out: ContrastPair[] = [];
	for (const itemId of items) {
		for (const partner of confusablesOf(graph, itemId)) {
			if (!pool.has(partner)) continue;
			const key = [itemId, partner].sort().join("|");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ itemId, partner, required: confusedBefore(attempts, itemId, partner) });
		}
	}
	return out;
}

/** Has this sitting asked a contrast on the pair (either way round)? */
export function contrastAsked(sitting: readonly Attempt[], a: string, b: string): boolean {
	return sitting.some((x) => x.role === "check" && x.check === "contrast" && ((x.conceptId === a && x.pairWith === b) || (x.conceptId === b && x.pairWith === a)));
}

/**
 * The required contrasts a sitting still owes (B2): pairs among the items it
 * attempted and its contrast partners that were confused before and have no
 * contrast check yet.
 */
export function owedContrasts(graph: ConceptGraph, attempts: readonly Attempt[], chatId: string, partners: readonly string[] = []): ContrastPair[] {
	const here = attempts.filter((a) => a.chatId === chatId);
	const attempted = [...new Set(here.filter((a) => a.role === "attempt").map((a) => a.conceptId))];
	return contrastPairs(graph, attempts, attempted, partners).filter((p) => p.required && !contrastAsked(here, p.itemId, p.partner));
}

/** How long a recent Again on a neighbour keeps counting as interference. */
const RECENT_AGAIN_DAYS = 7;

/**
 * Consolidation clusters (consolidation plan §4, C1): take the most overdue
 * learning/relearning concept, add its due prerequisites and dependents, its confusable
 * concepts, and concepts from the same source sitting that failed recently;
 * a mature prerequisite joins as a warm-up. Repeat until `capacity` items
 * are placed. Deterministic.
 */
export function consolidationClusters(input: {
	candidates: readonly ReviewCandidate[];
	snapshot: readonly MemoryItemSnapshot[];
	graph: ConceptGraph;
	capacity: number;
	nowMs: number;
	/** The attempt log, to mark contrasts on pairs confused before as required. */
	attempts?: readonly Attempt[];
}): ConsolidationCluster[] {
	const byId = new Map(input.snapshot.map((s) => [s.id, s]));
	const candidateIds = new Set(input.candidates.map((c) => c.itemId));
	const placed = new Set<string>();
	const clusters: ConsolidationCluster[] = [];
	const order = [...input.candidates].sort((a, b) => b.daysOverdue - a.daysOverdue || (a.recall ?? 0) - (b.recall ?? 0));
	const recentAgain = (id: string) => byId.get(id)?.events.some((e) => e.rating === 1 && input.nowMs - Date.parse(e.at) < RECENT_AGAIN_DAYS * DAY_MS) ?? false;
	let count = 0;
	for (const seed of order) {
		if (count >= input.capacity) break;
		if (placed.has(seed.itemId)) continue;
		const reasons: Record<string, string> = { [seed.itemId]: "most overdue" };
		const itemIds: string[] = [];
		const warmUps: string[] = [];
		for (const pre of prerequisitesOf(input.graph, seed.itemId)) {
			if (placed.has(pre)) continue;
			if (candidateIds.has(pre)) { itemIds.push(pre); reasons[pre] = `due prerequisite of ${seed.itemId}`; }
			else if (byId.get(pre)?.stage === "mature") { warmUps.push(pre); reasons[pre] = `mature prerequisite of ${seed.itemId}: warm-up`; }
		}
		itemIds.push(seed.itemId);
		// A due dependent is studied right after its prerequisite.
		for (const dep of dependentsOf(input.graph, seed.itemId)) {
			if (candidateIds.has(dep) && !placed.has(dep) && !itemIds.includes(dep)) { itemIds.push(dep); reasons[dep] = `due dependent of ${seed.itemId}`; }
		}
		const seedItem = byId.get(seed.itemId);
		const neighbours = confusablesOf(input.graph, seed.itemId);
		for (const id of neighbours) if (candidateIds.has(id) && !placed.has(id) && !itemIds.includes(id)) { itemIds.push(id); reasons[id] = `easily confused with ${seed.itemId}`; }
		for (const other of input.candidates) {
			const o = byId.get(other.itemId);
			if (!o || placed.has(o.id) || itemIds.includes(o.id) || !seedItem) continue;
			if (o.chatIds.some((c) => seedItem.chatIds.includes(c)) && recentAgain(o.id)) { itemIds.push(o.id); reasons[o.id] = `same source sitting, failed recently`; }
		}
		const room = Math.max(1, input.capacity - count);
		const kept = itemIds.slice(0, room);
		if (!kept.includes(seed.itemId)) kept[kept.length - 1] = seed.itemId;
		for (const id of kept) placed.add(id);
		for (const id of warmUps) placed.add(id);
		count += kept.length;
		// B3: a look-alike that is not due still joins, as a contrast partner only.
		const contrastPartners: string[] = [];
		for (const id of kept) {
			for (const other of confusablesOf(input.graph, id)) {
				if (kept.includes(other) || contrastPartners.includes(other) || candidateIds.has(other) || !byId.get(other)?.state) continue;
				contrastPartners.push(other);
				reasons[other] = `look-alike of ${id}, not due: contrast partner only`;
			}
		}
		const contrasts = contrastPairs(input.graph, input.attempts ?? [], kept, contrastPartners);
		clusters.push({
			seed: seed.itemId, itemIds: kept, warmUps, contrastPartners, contrasts,
			reasons: Object.fromEntries(Object.entries(reasons).filter(([id]) => kept.includes(id) || warmUps.includes(id) || contrastPartners.includes(id))),
		});
	}
	return clusters;
}

/** How many other items a retry waits behind after an Again. */
export const RETRY_GAP = 2;

export interface RetryQueue {
	waiting: string[];
	ready: string[];
	remaining: string[];
}

/**
 * The sitting's deferred retries (owner, 2026-11-18: interleave before
 * retrying). An Again is repaired at once, but its retry waits until
 * RETRY_GAP other items have had their first attempt, or until none remain.
 */
export function retryQueue(sessionAttempts: readonly Attempt[], picked: readonly string[], gap = RETRY_GAP): RetryQueue {
	const rows = [...sessionAttempts].filter((a) => picked.includes(a.conceptId)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const firsts: Attempt[] = [];
	const seen = new Set<string>();
	for (const a of rows) if (a.role === "attempt" && !seen.has(a.conceptId)) { seen.add(a.conceptId); firsts.push(a); }
	const retried = new Set(rows.filter((a) => a.role === "retry").map((a) => a.conceptId));
	const remaining = picked.filter((id) => !seen.has(id));
	const waiting: string[] = [];
	const ready: string[] = [];
	firsts.forEach((a, index) => {
		if (a.rating !== 1 || a.noRetry || retried.has(a.conceptId)) return;
		const since = firsts.length - 1 - index;
		(since >= gap || remaining.length === 0 ? ready : waiting).push(a.conceptId);
	});
	return { waiting, ready, remaining };
}
