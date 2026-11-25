/**
 * Courses (2026-11-23, docs/course-plans-plan.md): one map, many sittings.
 *
 * A course holds what a topic needs across sittings: the sources the
 * learner brought (and a tutor-written digest of them), ONE full plan map,
 * and the list of its sittings. A sitting is still one time-boxed chat; the
 * time budget limits a sitting's goals, never the course map.
 *
 * Identity (§3): a course has its own id (crs_…). Memory items of a course
 * are keyed `${courseId}#${nodeId}`. Items that existed before the course
 * keep their stored `${chatId}#${nodeId}` key; the course's `aliases` map
 * them onto course nodes, and every read resolves through them, so nothing
 * stored is ever rewritten. Pure: no IO here.
 */
import type { PlanEdge, PlanNode, PlanTree } from "./contracts/plan.ts";
import type { SessionGoal } from "./session-clock.ts";

export const COURSE_FORMAT = 1;
export const COURSE_ID_PATTERN = /^crs_[A-Za-z0-9_-]+$/;
/** Past this many nodes plan_init warns that the course may be two courses. */
export const COURSE_MAP_SOFT_LIMIT = 40;
/** The digest's size cap, in characters (about 4k tokens). */
export const COURSE_DIGEST_MAX_CHARS = 16_000;

export interface CourseSource {
	chatId: string;
	/** The learner message that brought it. */
	messageId: string;
	text: string;
	/** Paths under the data dir, e.g. pasted-images/…, as the message named them. */
	attachments: string[];
}

export interface CourseSitting {
	chatId: string;
	startedAt: string;
	closedAt?: string;
	budgetMin?: number;
	/** practice and review chats count as evidence-only sittings (§9.2). */
	kind?: "teach" | "practice" | "review";
	goals: SessionGoal[];
	handoff?: string;
	/** "reconstructed": written at adoption (§9), not at a close. */
	handoffSource?: "close" | "reconstructed";
}

export interface CourseRecord {
	format: typeof COURSE_FORMAT;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	sources: CourseSource[];
	digest?: string;
	map: PlanTree;
	mapHistory: Array<{ at: string; chatId: string; tree: PlanTree }>;
	sittings: CourseSitting[];
	/** Old item key `${chatId}#${nodeId}` → course node id. */
	aliases: Record<string, string>;
}

/** The courses store port (adapter: src/store/courses.ts). */
export interface CourseStore {
	list(): CourseRecord[];
	get(id: string): CourseRecord | null;
	save(course: CourseRecord): void;
	delete(id: string): boolean;
}

export const newCourseId = (nowMs = Date.now()) => `crs_${nowMs.toString(36)}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
export const isCourseId = (id: string) => id.startsWith("crs_");
export const courseItemId = (courseId: string, nodeId: string) => `${courseId}#${nodeId}`;

export function emptyCourse(input: { id?: string; title: string; nowIso: string; map?: PlanTree }): CourseRecord {
	return {
		format: COURSE_FORMAT,
		id: input.id ?? newCourseId(Date.parse(input.nowIso)),
		title: input.title,
		createdAt: input.nowIso,
		updatedAt: input.nowIso,
		sources: [],
		map: input.map ?? { nodes: [], edges: [], version: 1 },
		mapHistory: [],
		sittings: [],
		aliases: {},
	};
}

export function isCourseRecord(value: unknown): value is CourseRecord {
	const r = value as Partial<CourseRecord> | null;
	return !!r && typeof r === "object" && r.format === COURSE_FORMAT && typeof r.id === "string" && COURSE_ID_PATTERN.test(r.id) &&
		typeof r.title === "string" && Array.isArray(r.sources) && !!r.map && Array.isArray(r.map.nodes) && Array.isArray(r.map.edges) &&
		Array.isArray(r.sittings) && !!r.aliases && typeof r.aliases === "object";
}

// ─── Item keys: which memory item a (chat, node) pair counts toward ─────────

export interface ItemKey {
	/** The memory item id. */
	id: string;
	courseId?: string;
	/** The node id within the item's map (course node when in a course). */
	nodeId: string;
}

export interface ItemKeyResolver {
	key(chatId: string, nodeId: string): ItemKey;
	/** A stored item id (review events) → the id it counts toward now. */
	itemId(stored: string): string;
	/** The course a chat belongs to, if any. */
	courseOf(chatId: string): string | undefined;
}

export const IDENTITY_ITEM_KEYS: ItemKeyResolver = {
	key: (chatId, nodeId) => ({ id: `${chatId}#${nodeId}`, nodeId }),
	itemId: (stored) => stored,
	courseOf: () => undefined,
};

/**
 * The resolver over a set of courses. A chat belongs to the course listing
 * it as a sitting. An explicit alias wins; otherwise a course sitting's node
 * id IS the course node id (sittings plan with the course's ids).
 */
export function courseItemKeys(courses: readonly CourseRecord[]): ItemKeyResolver {
	const courseOfChat = new Map<string, CourseRecord>();
	for (const course of courses) for (const sitting of course.sittings) courseOfChat.set(sitting.chatId, course);
	const key = (chatId: string, nodeId: string): ItemKey => {
		const course = courseOfChat.get(chatId);
		if (!course) return { id: `${chatId}#${nodeId}`, nodeId };
		const mapped = course.aliases[`${chatId}#${nodeId}`] ?? nodeId;
		return { id: courseItemId(course.id, mapped), courseId: course.id, nodeId: mapped };
	};
	return {
		key,
		itemId(stored) {
			if (isCourseId(stored)) return stored;
			const hash = stored.indexOf("#");
			if (hash < 0) return stored;
			return key(stored.slice(0, hash), stored.slice(hash + 1)).id;
		},
		courseOf: (chatId) => courseOfChat.get(chatId)?.id,
	};
}

// ─── Sources ─────────────────────────────────────────────────────────────────

/** Attachment paths a learner message names (pasted images, files under the data dir). */
export function attachmentPaths(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/`([^`\n]+)`/g)) {
		const p = match[1]!.trim();
		if (/pasted-images[\\/]/.test(p) || /\.(png|jpe?g|webp|gif|pdf)$/i.test(p)) found.add(p);
	}
	return [...found];
}

// ─── Map edits ───────────────────────────────────────────────────────────────

/**
 * Node ids are memory keys (§3): a new course map must keep every course
 * node that has evidence. Returns the ids the new map would drop.
 */
export function droppedEvidencedNodes(course: CourseRecord, next: PlanTree, evidencedNodeIds: ReadonlySet<string>): string[] {
	const kept = new Set(next.nodes.map((n) => n.id));
	return course.map.nodes.filter((n) => evidencedNodeIds.has(n.id) && !kept.has(n.id)).map((n) => n.id);
}

export function withMap(course: CourseRecord, tree: PlanTree, chatId: string, nowIso: string): CourseRecord {
	const history = course.map.nodes.length ? [...course.mapHistory, { at: nowIso, chatId, tree: course.map }] : course.mapHistory;
	return { ...course, map: tree, mapHistory: history, updatedAt: nowIso };
}

export function upsertSitting(course: CourseRecord, sitting: CourseSitting, nowIso: string): CourseRecord {
	const others = course.sittings.filter((s) => s.chatId !== sitting.chatId);
	const sittings = [...others, sitting].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	return { ...course, sittings, updatedAt: nowIso };
}

// ─── Course node statuses (§2, §5) ───────────────────────────────────────────

export type CourseNodeState = "done" | "stale" | "started" | "later";

export interface CourseNodeView {
	id: string;
	title: string;
	state: CourseNodeState;
	/** Habits named on this node's evidence anywhere in the course. */
	habits: string[];
}

/** One evidence fact per node, already resolved onto course node ids. */
export interface CourseNodeFacts {
	solid: boolean;
	attempted: boolean;
	stale: boolean;
	habits: readonly string[];
}

export function courseNodeViews(course: CourseRecord, facts: ReadonlyMap<string, CourseNodeFacts>): CourseNodeView[] {
	return course.map.nodes.map((node) => {
		const f = facts.get(node.id);
		const state: CourseNodeState = !f ? "later" : f.solid ? (f.stale ? "stale" : "done") : f.attempted ? "started" : "later";
		return { id: node.id, title: node.title, state, habits: [...new Set(f?.habits ?? [])] };
	});
}

export function courseProgress(views: readonly CourseNodeView[]): { done: number; total: number } {
	return { done: views.filter((v) => v.state === "done").length, total: views.length };
}

// ─── The seed (§5) ───────────────────────────────────────────────────────────

const STATE_MARK: Record<CourseNodeState, string> = { done: "✓", stale: "~", started: "…", later: "·" };

function sittingLine(sitting: CourseSitting, index: number, title: (chatId: string) => string): string {
	const date = sitting.startedAt.slice(0, 10);
	const verdicts = sitting.goals.length ? sitting.goals.map((g) => `${g.id}: ${g.status}`).join(", ") : sitting.kind && sitting.kind !== "teach" ? sitting.kind : "no goals";
	return `${index + 1}) ${date} · ${title(sitting.chatId)}${sitting.budgetMin ? ` · ${sitting.budgetMin} min` : ""}${sitting.closedAt ? "" : " · not closed"} · ${verdicts}`;
}

/**
 * The context a sitting of this course starts from: sources (as the digest
 * when there is one), the full map with statuses, the sitting history and
 * the last hand-off. Deterministic for a given course state, so the system
 * prompt stays stable within a sitting.
 */
export function courseSeed(input: {
	course: CourseRecord;
	chatId: string;
	views: readonly CourseNodeView[];
	sittingTitle: (chatId: string) => string;
}): string {
	const { course, chatId, views } = input;
	const index = course.sittings.findIndex((s) => s.chatId === chatId);
	const number = index >= 0 ? index + 1 : course.sittings.length + 1;
	const earlier = course.sittings.filter((s) => s.chatId !== chatId);
	const lastHandoff = [...earlier].reverse().find((s) => s.handoff);
	const progress = courseProgress(views);
	const sources = course.digest
		? `## Sources (digest)\n${course.digest}`
		: course.sources.length
			? `## Sources (no digest yet: read these, then call record_digest)\n` + course.sources.map((s, i) =>
				`### Source ${i + 1}${s.attachments.length ? ` (attachments: ${s.attachments.map((a) => `\`${a}\``).join(", ")})` : ""}\n${s.text.trim()}`).join("\n\n")
			: "## Sources\nNone recorded.";
	const map = views.length
		? views.map((v) => `- ${STATE_MARK[v.state]} \`${v.id}\` ${v.title}${v.state === "stale" ? " (stale: solid once, recall now below target)" : ""}${v.habits.length ? ` [habits: ${v.habits.join(", ")}]` : ""}`).join("\n")
		: "(no map yet)";
	const edges = course.map.edges.length ? `\nEdges (prerequisite → dependent): ${course.map.edges.map((e: PlanEdge) => `${e.from}→${e.to}`).join(", ")}` : "";
	return [
		`# Course: ${course.title} · sitting ${number} of this course`,
		"This chat is one sitting of a longer course. The course map below is the big picture and lasts across sittings; this sitting's goals are a slice of it.",
		sources,
		`## Course map (${progress.done}/${progress.total} done; ✓ done, ~ stale, … started, · later)\n${map}${edges}`,
		earlier.length ? `## Earlier sittings\n${earlier.map((s, i) => sittingLine(s, i, input.sittingTitle)).join("\n")}` : "",
		carriedGoals(earlier),
		lastHandoff?.handoff ? `## Last hand-off${lastHandoff.handoffSource === "reconstructed" ? " (reconstructed at adoption, not written at a close: verify before relying on it)" : ""}\n${lastHandoff.handoff.trim()}` : "",
	].filter(Boolean).join("\n\n");
}

/** The last sitting's unmet goals, in its own words: the first candidates for this sitting's slice. */
function carriedGoals(earlier: readonly CourseSitting[]): string {
	const last = [...earlier].reverse().find((s) => s.goals.length);
	const open = last?.goals.filter((g) => g.status !== "met") ?? [];
	return open.length ? `## Not yet met at the last sitting\n${open.map((g) => `- ${g.text} (${g.status})`).join("\n")}` : "";
}

/** The doctrine for a course sitting (appended after the time-box doctrine). */
export function courseDoctrine(continuation: boolean): string {
	return [
		"# Course sittings",
		"- **The map is the course's, not the sitting's.** Keep the full map. If you call `plan_init`, pass the WHOLE course map (keep every existing node id; you may add nodes, and edges between parts). Never cut it down to what fits this sitting: the time budget limits the goals, and `set_goals` says when a slice is too big.",
		"- **Goals are a slice.** `set_goals` takes 1–3 goals whose nodes come from the course map. Prefer, in order: unmet or partial goals from the last sitting, frontier nodes (all prerequisites done), what the sources weight (exam problems), stale nodes to refresh. The learner may pick a different slice.",
		"- **Sources.** If the course has no digest yet, read the sources (and their attachments) and call `record_digest` once: the outline or every problem with its number and statement, plus what the learner said about the context. Later sittings get the digest instead of the attachments.",
		"- **Hand-off.** At `close_session`, write what changed this sitting: what holds, what is fragile (name habits), and a few of the learner's own words per fragile item. The map holds the \"later\" list, so don't repeat it.",
		...(continuation ? [
			"- **This sitting continues the course: recap, don't re-place.** Do not run a placement probe. Spend at most ~3 minutes on a recap retrieval: one short written question per fragile item from the last hand-off, and one per stale node in the slice you are about to propose. Then end the probe and propose this sitting's goals as a slice of the course map.",
		] : []),
	].join("\n");
}

// ─── Adoption (§9) ───────────────────────────────────────────────────────────

/** One row of the node-matching table (§9.2). */
export interface NodeMatchRow {
	/** The course node id the row produces. */
	courseNodeId: string;
	title: string;
	/** chatId → that chat's node id. */
	from: Record<string, string>;
	action: "merge" | "separate" | "drop";
	/** Why the row was proposed this way. */
	reason: string;
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "by", "with", "from", "as", "at", "via"]);
function tokens(title: string): Set<string> {
	return new Set(title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9α-ωℝℍ²³+=-]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)));
}
export function titleSimilarity(a: string, b: string): number {
	const x = tokens(a), y = tokens(b);
	if (!x.size || !y.size) return 0;
	let shared = 0;
	for (const t of x) if (y.has(t)) shared++;
	return shared / (x.size + y.size - shared);
}
/** Above this similarity, rows are proposed as one node (the learner confirms). */
export const MATCH_THRESHOLD = 0.6;

function slugify(raw: string): string {
	return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
}

/**
 * Propose the matching table for grouping chats (§9.2). Deterministic and
 * conservative: identical slugs with similar titles, or very similar titles,
 * are proposed as merges; everything else stays separate. The learner
 * confirms every row before anything is written.
 */
export function proposeNodeMatches(chats: ReadonlyArray<{ chatId: string; tree: PlanTree | undefined }>): NodeMatchRow[] {
	const rows: NodeMatchRow[] = [];
	const used = new Set<string>();
	const unique = (base: string) => { let id = slugify(base); for (let n = 2; used.has(id); n++) id = `${slugify(base)}-${n}`; used.add(id); return id; };
	for (const { chatId, tree } of chats) {
		for (const node of tree?.nodes ?? []) {
			let best: { row: NodeMatchRow; score: number } | null = null;
			for (const row of rows) {
				if (row.from[chatId]) continue; // one node per chat per row
				const sameSlug = Object.values(row.from).includes(node.id);
				const score = titleSimilarity(row.title, node.title) + (sameSlug ? 0.25 : 0);
				if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { row, score };
			}
			if (best) {
				best.row.from[chatId] = node.id;
				best.row.action = "merge";
				best.row.reason = `titles match (${Math.round(Math.min(1, best.score) * 100)}%)`;
			} else {
				rows.push({ courseNodeId: unique(node.id), title: node.title, from: { [chatId]: node.id }, action: "separate", reason: "only one" });
			}
		}
	}
	return rows;
}

/** Validate a confirmed table: every from-entry names a real node, ids are unique slugs. */
export function matchTableProblems(rows: readonly NodeMatchRow[], chats: ReadonlyArray<{ chatId: string; tree: PlanTree | undefined }>): string[] {
	const problems: string[] = [];
	const nodeSets = new Map(chats.map((c) => [c.chatId, new Set(c.tree?.nodes.map((n) => n.id) ?? [])]));
	const ids = new Set<string>();
	const claimed = new Set<string>();
	for (const row of rows) {
		if (row.action !== "drop") {
			if (!/^[a-z0-9_-]+$/.test(row.courseNodeId)) problems.push(`"${row.courseNodeId}" is not a lowercase slug.`);
			if (ids.has(row.courseNodeId)) problems.push(`"${row.courseNodeId}" is used twice.`);
			ids.add(row.courseNodeId);
		}
		if (row.action === "merge" && Object.keys(row.from).length < 2) problems.push(`Row "${row.courseNodeId}" merges fewer than two nodes.`);
		for (const [chatId, nodeId] of Object.entries(row.from)) {
			if (!nodeSets.get(chatId)?.has(nodeId)) problems.push(`${chatId} has no node "${nodeId}".`);
			const key = `${chatId}#${nodeId}`;
			if (claimed.has(key)) problems.push(`${key} appears in two rows.`);
			claimed.add(key);
		}
	}
	return problems;
}

/**
 * Apply a confirmed table: the combined map (edges carried over from each
 * chat, remapped; dropped nodes and their edges removed) and the aliases.
 * A "separate" row with several sources is split into one node per source.
 */
export function mapFromMatches(rows: readonly NodeMatchRow[], chats: ReadonlyArray<{ chatId: string; tree: PlanTree | undefined }>, base?: PlanTree): { map: PlanTree; aliases: Record<string, string> } {
	const aliases: Record<string, string> = {};
	const nodes: PlanNode[] = [...(base?.nodes ?? [])];
	const have = new Set(nodes.map((n) => n.id));
	const add = (id: string, title: string, summary?: string) => {
		if (have.has(id)) return;
		have.add(id);
		nodes.push({ id, title, ...(summary ? { summary } : {}) });
	};
	const titleOf = (chatId: string, nodeId: string) => chats.find((c) => c.chatId === chatId)?.tree?.nodes.find((n) => n.id === nodeId);
	for (const row of rows) {
		if (row.action === "drop") continue;
		const entries = Object.entries(row.from);
		if (row.action === "separate" && entries.length > 1) {
			entries.forEach(([chatId, nodeId], i) => {
				const id = i === 0 ? row.courseNodeId : `${row.courseNodeId}-${i + 1}`;
				const node = titleOf(chatId, nodeId);
				add(id, node?.title ?? row.title, node?.summary);
				aliases[`${chatId}#${nodeId}`] = id;
			});
			continue;
		}
		const first = entries[0] ? titleOf(entries[0][0], entries[0][1]) : undefined;
		add(row.courseNodeId, row.title, first?.summary);
		for (const [chatId, nodeId] of entries) aliases[`${chatId}#${nodeId}`] = row.courseNodeId;
	}
	const edges: PlanEdge[] = [...(base?.edges ?? [])];
	const seen = new Set(edges.map((e) => `${e.from}>${e.to}`));
	for (const { chatId, tree } of chats) {
		for (const edge of tree?.edges ?? []) {
			const from = aliases[`${chatId}#${edge.from}`], to = aliases[`${chatId}#${edge.to}`];
			if (!from || !to || from === to || seen.has(`${from}>${to}`)) continue;
			seen.add(`${from}>${to}`);
			edges.push({ from, to });
		}
	}
	return { map: { nodes, edges: dropCycles(nodes, edges), version: (base?.version ?? 0) + 1 }, aliases };
}

/** Merging two maps can create a cycle; drop the edges that close one (later edges first). */
function dropCycles(nodes: readonly PlanNode[], edges: readonly PlanEdge[]): PlanEdge[] {
	const kept: PlanEdge[] = [];
	const out = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
	const reaches = (from: string, to: string): boolean => {
		const stack = [from], seen = new Set<string>();
		while (stack.length) {
			const at = stack.pop()!;
			if (at === to) return true;
			if (seen.has(at)) continue;
			seen.add(at);
			for (const next of out.get(at) ?? []) stack.push(next);
		}
		return false;
	};
	for (const edge of edges) {
		if (reaches(edge.to, edge.from)) continue;
		out.get(edge.from)?.add(edge.to);
		kept.push(edge);
	}
	return kept;
}

/**
 * A deterministic hand-off for an adopted chat (§9.1), marked reconstructed:
 * what holds per its evidence, the habits that recur, and where it stopped.
 */
export function reconstructedHandoff(input: {
	title: string;
	views: ReadonlyArray<{ title: string; state: CourseNodeState; habits: readonly string[] }>;
	lastNodeTitle?: string;
	lastTeacherText?: string;
	pendingQuestion?: string;
}): string {
	const holds = input.views.filter((v) => v.state === "done").map((v) => v.title);
	const stale = input.views.filter((v) => v.state === "stale").map((v) => v.title);
	const started = input.views.filter((v) => v.state === "started");
	const habits = [...new Set(input.views.flatMap((v) => v.habits))];
	const excerpt = input.lastTeacherText ? input.lastTeacherText.replace(/\s+/g, " ").trim().slice(0, 400) : "";
	return [
		`Reconstructed from "${input.title}" at adoption (no close was run there).`,
		`**What holds (evidence):** ${holds.length ? holds.join("; ") : "nothing credited yet"}.`,
		stale.length ? `**Stale (solid once, recall now low):** ${stale.join("; ")}.` : "",
		started.length ? `**Fragile (started, not solid):** ${started.map((v) => v.habits.length ? `${v.title} [${v.habits.join(", ")}]` : v.title).join("; ")}.` : "",
		habits.length ? `**Recurring habits:** ${habits.join(", ")}.` : "",
		`**Where it stopped:** ${input.pendingQuestion ? `mid-question: ${input.pendingQuestion.slice(0, 300)}` : input.lastNodeTitle ? `on "${input.lastNodeTitle}"` : "unknown"}${excerpt ? `. Last tutor message: "${excerpt}${input.lastTeacherText!.length > 400 ? "…" : ""}"` : ""}.`,
	].filter(Boolean).join("\n");
}
