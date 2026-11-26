/**
 * GLOBAL MATH CONCEPTS (2026-11-25, docs/global-concepts-plan.md).
 *
 * One math node per idea, shared by every session: a math-mode plan node id
 * IS a concept id. Every graded learner attempt on a concept, from any
 * session kind, goes to ONE append-only log (attempts); schedules, statuses
 * and the gate are derived from it on every read. There is no per-chat key,
 * no alias table and no `assumed` outcome: an earlier session's evidence
 * counts directly because the concept is the same.
 *
 * Scope (owner, 2026-11-25): one concept is ONE testable unit (one
 * definition, theorem, technique, example family or fact), and it carries
 * its `statement`, so a review can test exactly that. Pure: no IO here.
 */
import { MATH_DIMENSIONS, MATH_HABITS, type MathDimension, type MathHabit } from "./math-evidence.ts";
import type { FsrsRating } from "./memory/fsrs.ts";

export const CONCEPTS_FORMAT = 1;

export const CONCEPT_KINDS = ["definition", "theorem", "technique", "example", "fact"] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

/** A mermaid-safe, descriptive, global slug. */
export const CONCEPT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** Ids too generic to be global: they would collide across topics. */
const GENERIC_IDS = new Set([
	"definition", "def", "defn", "theorem", "lemma", "proof", "example", "examples", "held", "retest", "review", "foundations",
	"basics", "intro", "introduction", "setup", "goal", "summary", "recap", "warmup", "warm-up", "statement", "idea", "main",
	"node", "step", "problem", "exercise", "drill", "check", "core", "overview", "motivation", "application", "applications",
]);

export interface Concept {
	id: string;
	title: string;
	summary?: string;
	kind: ConceptKind;
	/** The exact content tested: a definition with every clause, a theorem with every hypothesis, a technique as its steps and when it applies. */
	statement: string;
	/** Per dimension, what a question on it must make the learner produce. */
	checks?: Partial<Record<MathDimension, string>>;
	/** The statement was drafted by the migration from the old summary: confirm it (update_concept) before quizzing. */
	scopeDraft?: true;
	createdAt: string;
	/** The chat whose plan first named it. */
	createdIn: string;
	status: "active" | "retired";
	/** Concept ids easily confused with this one (consolidation interference grouping). */
	confusableWith?: string[];
}

export interface ConceptEdge {
	/** Prerequisite concept id. */
	from: string;
	to: string;
	/** The chat whose plan added the edge. */
	addedIn: string;
}

export interface ConceptGraph {
	format: typeof CONCEPTS_FORMAT;
	concepts: Record<string, Concept>;
	edges: ConceptEdge[];
}

export const emptyConceptGraph = (): ConceptGraph => ({ format: CONCEPTS_FORMAT, concepts: {}, edges: [] });

// ─── Attempts ────────────────────────────────────────────────────────────────

export const ATTEMPT_SOURCES = ["teach", "probe", "review", "consolidate"] as const;
export type AttemptSource = (typeof ATTEMPT_SOURCES)[number];
/** attempt = a graded answer; retry/followup/check are the review ladder's log-only roles. */
export const ATTEMPT_ROLES = ["attempt", "retry", "followup", "check"] as const;
export type AttemptRole = (typeof ATTEMPT_ROLES)[number];
export const ATTEMPT_OUTCOMES = ["correct", "correct_slow", "partial", "incorrect", "learner_override"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export const ATTEMPT_CHECKS = ["repair", "close", "contrast"] as const;
export type AttemptCheck = (typeof ATTEMPT_CHECKS)[number];

/** One line of math/attempts.jsonl. */
export interface Attempt {
	/** The tool-call id that recorded it (record_evidence / record_review), or a server id for implicit credit. */
	id: string;
	conceptId: string;
	/** The sitting. */
	chatId: string;
	at: string;
	source: AttemptSource;
	role: AttemptRole;
	dimension: MathDimension;
	outcome: AttemptOutcome;
	hints: number;
	note: string;
	/** The grade → FSRS rating at write time (ratingFor). Absent on learner_override. */
	rating?: FsrsRating;
	/** What was asked, so the next review avoids repeating it. */
	question?: string;
	/** The explain/recall tool call this attempt grades (probe answers). */
	questionCallId?: string;
	loadBearing?: boolean;
	confidence?: number;
	elapsedSeconds?: number;
	expectedSeconds?: number;
	habits?: MathHabit[];
	minutesIn?: number;
	noRetry?: boolean;
	check?: AttemptCheck;
	/** A contrast check's other concept: the one asked side by side with this one (docs/depth-and-contrast-plan.md B2). */
	pairWith?: string;
	/** The look-alike concept the answer produced instead of this one (B1). */
	confusedWith?: string;
	/** Recall the schedule predicted just before this attempt. */
	predicted?: number;
	/** Implicit credit along a prerequisite edge, written by the server (setting, default off). */
	implicit?: true;
}

/** An old `assumed` record, kept as a note (math/unverified.jsonl, decision D3). It never schedules anything. */
export interface UnverifiedNote {
	id: string;
	conceptId: string;
	chatId: string;
	at: string;
	dimension: MathDimension;
	note: string;
}

/** Math-mode switches (math/options.json), set on the Memory page. */
export interface MathOptions {
	/** R7: a clean U/S/P review gives due direct prerequisites a Hard. Default off. */
	implicitCredit: boolean;
}
export const DEFAULT_MATH_OPTIONS: MathOptions = { implicitCredit: false };

/** The port for the math data (fs adapter: src/store/math.ts). */
export interface MathStore {
	options(): MathOptions;
	saveOptions(options: MathOptions): void;
	graph(): ConceptGraph;
	saveGraph(graph: ConceptGraph): void;
	/** Every attempt, oldest first; a repeated id keeps its first line. */
	attempts(): Attempt[];
	/** Appends one attempt. Throws on failure: the log is the truth. */
	appendAttempt(attempt: Attempt): void;
	unverified(): UnverifiedNote[];
	/** Rewrite every attempt / note on `from` to `into` (a concept merge). */
	rewriteConcept(from: string, into: string): number;
	/** Drop one chat's attempts and notes, and the concepts only it created that nothing else
	 *  references (`stillReferenced`: concept ids other chats' plans or courses still name). */
	removeChat(chatId: string, stillReferenced?: ReadonlySet<string>): number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const optNum = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export function isAttempt(value: unknown): value is Attempt {
	const r = value as Record<string, unknown> | null;
	return !!r && typeof r === "object" &&
		isStr(r.id) && isStr(r.conceptId) && isStr(r.chatId) && isStr(r.at) && Number.isFinite(Date.parse(r.at as string)) &&
		inList(ATTEMPT_SOURCES, r.source) && inList(ATTEMPT_ROLES, r.role) && inList(MATH_DIMENSIONS, r.dimension) &&
		inList(ATTEMPT_OUTCOMES, r.outcome) && typeof r.hints === "number" && isStr(r.note) &&
		(r.rating === undefined || [1, 2, 3, 4].includes(r.rating as number)) &&
		(r.question === undefined || isStr(r.question)) && (r.questionCallId === undefined || isStr(r.questionCallId)) &&
		(r.loadBearing === undefined || typeof r.loadBearing === "boolean") && (r.noRetry === undefined || typeof r.noRetry === "boolean") &&
		(r.check === undefined || inList(ATTEMPT_CHECKS, r.check)) &&
		(r.pairWith === undefined || isStr(r.pairWith)) && (r.confusedWith === undefined || isStr(r.confusedWith)) && (r.implicit === undefined || r.implicit === true) &&
		optNum(r.confidence) && optNum(r.elapsedSeconds) && optNum(r.expectedSeconds) && optNum(r.minutesIn) && optNum(r.predicted) &&
		(r.habits === undefined || (Array.isArray(r.habits) && r.habits.every((t) => inList(MATH_HABITS, t))));
}

export function isUnverifiedNote(value: unknown): value is UnverifiedNote {
	const r = value as Record<string, unknown> | null;
	return !!r && isStr(r.id) && isStr(r.conceptId) && isStr(r.chatId) && isStr(r.at) && inList(MATH_DIMENSIONS, r.dimension) && isStr(r.note);
}

function isConcept(value: unknown): value is Concept {
	const c = value as Record<string, unknown> | null;
	return !!c && isStr(c.id) && CONCEPT_ID_PATTERN.test(c.id as string) && isStr(c.title) && inList(CONCEPT_KINDS, c.kind) &&
		isStr(c.statement) && isStr(c.createdAt) && isStr(c.createdIn) && (c.status === "active" || c.status === "retired") &&
		(c.summary === undefined || isStr(c.summary)) && (c.scopeDraft === undefined || c.scopeDraft === true) &&
		(c.confusableWith === undefined || (Array.isArray(c.confusableWith) && c.confusableWith.every(isStr))) &&
		(c.checks === undefined || (typeof c.checks === "object" && Object.entries(c.checks as object).every(([k, v]) => inList(MATH_DIMENSIONS, k) && isStr(v))));
}

export function isConceptGraph(value: unknown): value is ConceptGraph {
	const g = value as Partial<ConceptGraph> | null;
	return !!g && g.format === CONCEPTS_FORMAT && !!g.concepts && typeof g.concepts === "object" &&
		Object.entries(g.concepts).every(([id, c]) => isConcept(c) && c.id === id) &&
		Array.isArray(g.edges) && g.edges.every((e) => isStr(e?.from) && isStr(e?.to) && isStr(e?.addedIn));
}

/** Why an id may not name a NEW concept; null when it may. */
export function newConceptIdProblem(id: string): string | null {
	if (!CONCEPT_ID_PATTERN.test(id)) return `"${id}" is not a lowercase slug (a-z, 0-9, hyphens, underscores).`;
	if (GENERIC_IDS.has(id) || id.length < 5 || !/[-_]/.test(id) && id.length < 10) {
		return `"${id}" is too generic for a global concept id. Name the idea itself, e.g. "compact-closed-in-hausdorff" or "upwind-cfl".`;
	}
	return null;
}

// ─── Scope ───────────────────────────────────────────────────────────────────

/** The scope fields a new concept must carry (D1). */
export interface ConceptScopeInput {
	kind: ConceptKind;
	statement: string;
	checks?: Partial<Record<MathDimension, string>>;
	summary?: string;
}

export const MIN_STATEMENT_CHARS = 20;

export function scopeProblems(id: string, scope: Partial<ConceptScopeInput> | undefined): string[] {
	const problems: string[] = [];
	if (!scope) return [`${id}: new concept needs its scope (kind and statement).`];
	if (!inList(CONCEPT_KINDS, scope.kind)) problems.push(`${id}: kind must be one of ${CONCEPT_KINDS.join(", ")}.`);
	if (!isStr(scope.statement) || scope.statement.trim().length < MIN_STATEMENT_CHARS) {
		problems.push(`${id}: statement must state exactly what is tested (at least ${MIN_STATEMENT_CHARS} characters): the definition with every clause, the theorem with every hypothesis, or the technique's steps and when it applies.`);
	}
	return problems;
}

/** A concept as the tutor sees it: enough to ask a fresh question on exactly it. */
export function conceptBrief(concept: Concept): Record<string, unknown> {
	return {
		id: concept.id,
		title: concept.title,
		kind: concept.kind,
		statement: concept.statement,
		...(concept.checks ? { checks: concept.checks } : {}),
		...(concept.scopeDraft ? { scopeDraft: true } : {}),
		...(concept.confusableWith?.length ? { confusableWith: concept.confusableWith } : {}),
	};
}

// ─── Similarity and search ───────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "by", "with", "from", "as", "at", "via", "its", "it", "be", "are", "that", "this"]);
function tokens(text: string): Set<string> {
	return new Set(text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9α-ω²³+=]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)));
}

/** Jaccard similarity of two texts' word sets. */
export function textSimilarity(a: string, b: string): number {
	const x = tokens(a), y = tokens(b);
	if (!x.size || !y.size) return 0;
	let shared = 0;
	for (const t of x) if (y.has(t)) shared++;
	return shared / (x.size + y.size - shared);
}

/** Above this, a new concept is flagged as a likely duplicate of an existing one. */
export const SIMILAR_THRESHOLD = 0.4;

/** Existing concepts that look like the same idea as `title` (+ statement), best first. */
export function similarConcepts(graph: ConceptGraph, text: string, options: { exclude?: ReadonlySet<string>; limit?: number } = {}): Array<{ concept: Concept; score: number }> {
	const hits: Array<{ concept: Concept; score: number }> = [];
	for (const concept of Object.values(graph.concepts)) {
		if (options.exclude?.has(concept.id) || concept.status === "retired") continue;
		const score = Math.max(textSimilarity(text, concept.title), textSimilarity(text, `${concept.title} ${concept.statement}`));
		if (score >= SIMILAR_THRESHOLD) hits.push({ concept, score });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 3);
}

/** Keyword search over id, title, summary and statement; best first. Null when the query holds no searchable term. */
export function searchConcepts(graph: ConceptGraph, query: string, limit = 20): Concept[] | null {
	const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
	if (terms.length === 0) return null;
	const scored = Object.values(graph.concepts).map((c) => {
		const text = `${c.id.replace(/[-_]/g, " ")}\n${c.title}\n${c.summary ?? ""}\n${c.statement}`.toLowerCase();
		return { c, score: terms.filter((t) => text.includes(t)).length };
	}).filter((x) => x.score > 0);
	scored.sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title));
	return scored.slice(0, limit).map((x) => x.c);
}

// ─── Graph edits (pure) ──────────────────────────────────────────────────────

/** Union plan edges into the global graph, skipping duplicates and any that would close a cycle. */
export function withEdges(graph: ConceptGraph, edges: ReadonlyArray<{ from: string; to: string }>, chatId: string): ConceptGraph {
	const next = [...graph.edges];
	const have = new Set(next.map((e) => `${e.from}>${e.to}`));
	const out = new Map<string, Set<string>>();
	for (const e of next) (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
	const reaches = (from: string, to: string) => {
		const stack = [from], seen = new Set<string>();
		while (stack.length) {
			const at = stack.pop()!;
			if (at === to) return true;
			if (seen.has(at)) continue;
			seen.add(at);
			for (const n of out.get(at) ?? []) stack.push(n);
		}
		return false;
	};
	for (const e of edges) {
		if (e.from === e.to || have.has(`${e.from}>${e.to}`) || reaches(e.to, e.from)) continue;
		have.add(`${e.from}>${e.to}`);
		(out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
		next.push({ from: e.from, to: e.to, addedIn: chatId });
	}
	return { ...graph, edges: next };
}

/** Direct prerequisites of a concept on the global graph. */
/** The concepts marked as easily confused with `id`, either way round. */
export function confusablesOf(graph: ConceptGraph, id: string): string[] {
	const out = new Set<string>(graph.concepts[id]?.confusableWith ?? []);
	for (const c of Object.values(graph.concepts)) if (c.confusableWith?.includes(id)) out.add(c.id);
	out.delete(id);
	return [...out].filter((x) => graph.concepts[x]);
}

/** Mark two concepts as confusable with each other (confusion is symmetric). Unchanged when either is missing or they are the same. */
export function linkConfusable(graph: ConceptGraph, a: string, b: string): ConceptGraph {
	const ca = graph.concepts[a];
	const cb = graph.concepts[b];
	if (!ca || !cb || a === b) return graph;
	const add = (c: Concept, other: string): Concept => ({ ...c, confusableWith: [...new Set([...(c.confusableWith ?? []), other])] });
	return { ...graph, concepts: { ...graph.concepts, [a]: add(ca, b), [b]: add(cb, a) } };
}

export const prerequisitesOf = (graph: ConceptGraph, id: string) => graph.edges.filter((e) => e.to === id).map((e) => e.from);
export const dependentsOf = (graph: ConceptGraph, id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);

/**
 * Merge concept `from` into `into` in the graph: edges are re-pointed (self
 * loops and duplicates dropped), confusable lists rewritten, `from` deleted.
 * The kept concept keeps its own scope. The attempt log, chat trees and
 * course maps are rewritten by the caller (server/concepts.ts).
 */
export function mergeInGraph(graph: ConceptGraph, from: string, into: string): ConceptGraph {
	if (from === into) return graph;
	const concepts: Record<string, Concept> = {};
	for (const [id, c] of Object.entries(graph.concepts)) {
		if (id === from) continue;
		const confusable = c.confusableWith?.map((x) => (x === from ? into : x)).filter((x) => x !== id);
		concepts[id] = confusable ? { ...c, confusableWith: [...new Set(confusable)] } : c;
	}
	const fromConcept = graph.concepts[from];
	if (fromConcept?.confusableWith?.length && concepts[into]) {
		const merged = [...new Set([...(concepts[into]!.confusableWith ?? []), ...fromConcept.confusableWith])].filter((x) => x !== into && x !== from);
		concepts[into] = { ...concepts[into]!, ...(merged.length ? { confusableWith: merged } : {}) };
	}
	const seen = new Set<string>();
	const edges: ConceptEdge[] = [];
	for (const e of graph.edges) {
		const f = e.from === from ? into : e.from, t = e.to === from ? into : e.to;
		if (f === t || seen.has(`${f}>${t}`)) continue;
		seen.add(`${f}>${t}`);
		edges.push({ ...e, from: f, to: t });
	}
	return { ...graph, concepts, edges };
}

/** Rewrite node ids in a mermaid plan text: whole-token replacement of ids that are node ids. */
export function rewriteMermaidIds(mermaid: string, map: ReadonlyMap<string, string>): string {
	if (map.size === 0) return mermaid;
	// Same shape as agent/tools/mermaid-plan.ts: a line is endpoints joined by
	// arrows; an endpoint is `id` plus an optional [label] / (label). Labels
	// are never touched.
	return mermaid.split("\n").map((line) => line.split(/(-->|==>|-\.->)/).map((part, i) => {
		if (i % 2 === 1) return part;
		const m = /^(\s*)([^\s()[\]]+)(.*)$/s.exec(part);
		if (!m) return part;
		const replaced = map.get(m[2]!);
		return replaced ? `${m[1]}${replaced}${m[3]}` : part;
	}).join("")).join("\n");
}

export const isMathDimension = (v: unknown): v is MathDimension => inList(MATH_DIMENSIONS, v);
