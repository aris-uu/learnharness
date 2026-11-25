/**
 * One-off migration to global math concepts (docs/global-concepts-plan.md §5).
 *
 *   npx tsx scripts/migrate-global-concepts.ts [--from <data dir>] [--out <dir>] [--write] [--report <file>] [--old-snapshot <json>]
 *
 * Dry run by default: it reads the old data folder, builds the new format in
 * memory and prints the report. With --write it writes a COMPLETE new data
 * folder at --out (default: "<from>.migrated"), copying everything that does
 * not change and never touching --from. The app must be closed. Swap the
 * folders by hand afterwards (data → data.pre-migration, data.migrated → data).
 *
 * --old-snapshot is the JSON the pre-migration code printed
 * (scripts/migration/old-snapshot.ts run from the old commit): per old item
 * key, its FSRS state. The report compares it with the new snapshot.
 */
import fs from "node:fs";
import path from "node:path";
import { rewriteChat, rewriteTree, nodeIdsOfChat } from "../src/core/concept-rewrite.ts";
import {
	CONCEPTS_FORMAT, emptyConceptGraph, isAttempt, isConceptGraph, isUnverifiedNote, newConceptIdProblem, withEdges,
	type Attempt, type Concept, type ConceptGraph, type ConceptKind, type MathStore, type UnverifiedNote,
} from "../src/core/math-concepts.ts";
import { ratingFor } from "../src/core/memory/review.ts";
import { memorySnapshot } from "../src/core/memory/items.ts";
import { COURSE_FORMAT } from "../src/core/course.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";

// ─── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const FROM = path.resolve(opt("--from") ?? path.join(process.env.APPDATA ?? "", "LearnHarness", "data"));
const OUT = path.resolve(opt("--out") ?? `${FROM}.migrated`);
const WRITE = flag("--write");
const REPORT = opt("--report");
const OLD_SNAPSHOT = opt("--old-snapshot");
const NOW = Date.parse(opt("--now") ?? new Date().toISOString());
const MAP_FILE = path.join(import.meta.dirname, "migration", "concept-map.json");

if (!fs.existsSync(path.join(FROM, "chats"))) throw new Error(`Not a LearnHarness data folder: ${FROM}`);
if (WRITE && fs.existsSync(OUT)) throw new Error(`${OUT} already exists. Remove it first; the migration never overwrites.`);

// ─── old data (read only) ────────────────────────────────────────────────
type Json = Record<string, any>;
const readJsonl = (file: string): Json[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const evidence = readJsonl(path.join(FROM, "evidence", "evidence.jsonl"));
const reviews = readJsonl(path.join(FROM, "memory", "reviews.jsonl"));
const chatFiles = fs.readdirSync(path.join(FROM, "chats")).filter((f) => f.endsWith(".json"));
const chats = new Map<string, Json>(chatFiles.map((f) => { const c = JSON.parse(fs.readFileSync(path.join(FROM, "chats", f), "utf-8")); return [c.id as string, c]; }));
const courseDir = path.join(FROM, "courses");
const courses: Json[] = fs.existsSync(courseDir) ? fs.readdirSync(courseDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(courseDir, f), "utf-8"))) : [];
const conceptMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf-8")) as { pairs: Record<string, string>; rename: Record<string, string>; titles: Record<string, string> };

const problems: string[] = [];
const notes: string[] = [];

// ─── which chats are math ────────────────────────────────────────────────
const isReview = (c: Json) => c.kind === "review";
const evidenceChats = new Set(evidence.map((e) => e.chatId as string));
const mathTeach = [...chats.values()].filter((c) => !isReview(c) && (c.settings?.profile === "math" || evidenceChats.has(c.id)));
const reviewChats = [...chats.values()].filter(isReview);

// ─── resolver: (chatId, slug) → concept id ───────────────────────────────
const aliasOf = new Map<string, string>(); // chat#slug → course slug
for (const course of courses) for (const [key, slug] of Object.entries((course.aliases ?? {}) as Record<string, string>)) aliasOf.set(key, slug);
const bySlug = (slug: string) => conceptMap.rename[slug] ?? slug;
function resolve(chatId: string, slug: string): string {
	const key = `${chatId}#${slug}`;
	if (conceptMap.pairs[key]) return conceptMap.pairs[key]!;
	return bySlug(aliasOf.get(key) ?? slug);
}
const resolveKey = (itemKey: string) => { const i = itemKey.indexOf("#"); return resolve(itemKey.slice(0, i), itemKey.slice(i + 1)); };

/** The old reviewNodeIds (pre-migration core/memory/review.ts): local slug → item key, per successful pick_items. */
function reviewNodeIds(itemIds: readonly string[]): Map<string, string> {
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
function toolCalls(chat: Json): Json[] {
	return (chat.messages ?? []).flatMap((m: Json) => (m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === "toolCall") : []));
}
function okResultIds(chat: Json, tool: string): Set<string> {
	return new Set((chat.messages ?? []).filter((m: Json) => m.role === "toolResult" && m.toolName === tool && !m.isError).map((m: Json) => m.toolCallId as string));
}
/** A review chat's local slugs → concept ids (and its pick item keys → concept ids). */
function reviewChatMap(chat: Json): Map<string, string> {
	const ok = okResultIds(chat, "pick_items");
	const map = new Map<string, string>();
	for (const call of toolCalls(chat)) {
		if (call.name !== "pick_items" || !ok.has(call.id) || !Array.isArray(call.arguments?.itemIds)) continue;
		for (const [slug, key] of reviewNodeIds(call.arguments.itemIds)) {
			const id = resolveKey(key);
			const prev = map.get(slug);
			if (prev && prev !== id) problems.push(`${chat.id}: local slug "${slug}" names two concepts across picks (${prev}, ${id}).`);
			map.set(slug, id);
			map.set(key, id);
		}
	}
	return map;
}

// ─── concepts ────────────────────────────────────────────────────────────
interface Seen { chatId: string; slug: string; title?: string; summary?: string; evidence: number; createdAt: string; fromCourse?: boolean }
const seen = new Map<string, Seen[]>(); // concept id → every old pair that maps to it
const note = (id: string, s: Seen) => (seen.get(id) ?? seen.set(id, []).get(id)!).push(s);
const evCount = new Map<string, number>();
for (const e of evidence) evCount.set(`${e.chatId}#${e.nodeId}`, (evCount.get(`${e.chatId}#${e.nodeId}`) ?? 0) + 1);

/** Every tree a chat ever had: the current one and each successful plan_init result. */
function chatTrees(chat: Json): PlanTree[] {
	const trees: PlanTree[] = [];
	for (const m of chat.messages ?? []) {
		if (m.role === "toolResult" && (m.toolName === "plan_init") && !m.isError && m.details?.tree?.nodes) trees.push(m.details.tree);
	}
	if (chat.tree?.nodes) trees.push(chat.tree);
	return trees;
}

const chatMaps = new Map<string, Map<string, string>>();
for (const chat of mathTeach) {
	const map = new Map<string, string>();
	const titles = new Map<string, { title?: string; summary?: string }>();
	for (const tree of chatTrees(chat)) for (const n of tree.nodes) titles.set(n.id, { title: n.title, summary: n.summary });
	const slugs = new Set<string>([...titles.keys(), ...nodeIdsOfChat({ messages: chat.messages ?? [], ...(chat.tree ? { tree: chat.tree } : {}) })]);
	for (const e of evidence) if (e.chatId === chat.id) slugs.add(e.nodeId);
	for (const slug of slugs) {
		const id = resolve(chat.id, slug);
		map.set(slug, id);
		const t = titles.get(slug);
		const evTitle = evidence.find((e) => e.chatId === chat.id && e.nodeId === slug)?.nodeTitle;
		note(id, { chatId: chat.id, slug, title: t?.title ?? (evTitle && evTitle !== slug ? evTitle : undefined), summary: t?.summary, evidence: evCount.get(`${chat.id}#${slug}`) ?? 0, createdAt: chat.createdAt });
	}
	chatMaps.set(chat.id, map);
}
for (const chat of reviewChats) chatMaps.set(chat.id, reviewChatMap(chat));
for (const course of courses) {
	for (const n of course.map?.nodes ?? []) note(bySlug(n.id), { chatId: course.id, slug: n.id, title: n.title, summary: n.summary, evidence: 0, createdAt: course.createdAt, fromCourse: true });
}

function guessKind(text: string): ConceptKind {
	if (/\b(def|definition|defined)\b/i.test(text) || /: definition/i.test(text)) return "definition";
	if (/\b(theorem|lemma|prop\b|proposition|formula|iff|classif)/i.test(text)) return "theorem";
	if (/\b(sheet|s[12] no|problem|worked|example|sketch|counterexample)/i.test(text)) return "example";
	if (/\b(scheme|method|ansatz|solve|compute|computing|guess|test|trace|separation|approximation)/i.test(text)) return "technique";
	return "fact";
}

let graph: ConceptGraph = emptyConceptGraph();
const merged: Array<{ id: string; pairs: string[] }> = [];
for (const [id, list] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
	const idProblem = newConceptIdProblem(id);
	if (idProblem) problems.push(`Concept id ${id}: ${idProblem}`);
	const chatPairs = list.filter((s) => !s.fromCourse);
	if (chatPairs.length === 0) { notes.push(`Course-only node ${id} (no math chat names it): kept as a concept.`); }
	// The name: an explicit title, else the course map's, else the pair with most evidence.
	const best = [...list].sort((a, b) => b.evidence - a.evidence || Number(!!b.fromCourse) - Number(!!a.fromCourse))[0]!;
	const title = conceptMap.titles[id] ?? list.find((s) => s.fromCourse)?.title ?? best.title ?? id;
	const summary = best.summary ?? list.find((s) => s.summary)?.summary;
	const first = [...chatPairs.length ? chatPairs : list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
	const statement = summary && summary.length >= title.length ? summary : title;
	const concept: Concept = {
		id, title, ...(summary ? { summary } : {}), kind: guessKind(`${title} ${summary ?? ""}`), statement,
		scopeDraft: true, createdAt: first.createdAt, createdIn: first.chatId, status: "active",
	};
	graph.concepts[id] = concept;
	const distinctPairs = [...new Set(chatPairs.map((s) => `${s.chatId}#${s.slug}`))];
	const distinctSlugs = new Set(chatPairs.map((s) => s.slug));
	if (distinctSlugs.size > 1 || (distinctPairs.length > 1 && new Set(chatPairs.map((s) => s.title)).size > 1)) merged.push({ id, pairs: distinctPairs });
}

// Global edges: every chat tree's and course map's edges, renamed (cycles skipped by withEdges).
for (const chat of mathTeach) {
	const map = chatMaps.get(chat.id)!;
	for (const tree of chatTrees(chat)) graph = withEdges(graph, tree.edges.map((e) => ({ from: map.get(e.from) ?? e.from, to: map.get(e.to) ?? e.to })).filter((e) => e.from !== e.to && graph.concepts[e.from] && graph.concepts[e.to]), chat.id);
}
for (const course of courses) {
	graph = withEdges(graph, (course.map?.edges ?? []).map((e: Json) => ({ from: bySlug(e.from), to: bySlug(e.to) })).filter((e: { from: string; to: string }) => e.from !== e.to && graph.concepts[e.from] && graph.concepts[e.to]), course.id);
}

// ─── attempts ────────────────────────────────────────────────────────────
const attempts: Attempt[] = [];
const unverified: UnverifiedNote[] = [];
const probeLike = (e: Json) => /^probe\b/i.test(e.note ?? "");
for (const e of evidence) {
	const conceptId = chatMaps.get(e.chatId)?.get(e.nodeId) ?? resolve(e.chatId, e.nodeId);
	if (!graph.concepts[conceptId]) { problems.push(`Evidence ${e.id} names unknown concept ${conceptId}.`); continue; }
	if (e.outcome === "assumed") {
		unverified.push({ id: e.id, conceptId, chatId: e.chatId, at: e.recordedAt, dimension: e.dimension, note: e.note });
		continue;
	}
	const a: Attempt = {
		id: e.id, conceptId, chatId: e.chatId, at: e.recordedAt, source: probeLike(e) ? "probe" : "teach", role: "attempt",
		dimension: e.dimension, outcome: e.outcome, hints: e.hints, note: e.note, rating: ratingFor(e as never),
		...(e.habits ? { habits: e.habits } : {}), ...(typeof e.minutesIn === "number" ? { minutesIn: e.minutesIn } : {}),
	};
	if (!isAttempt(a)) { problems.push(`Evidence ${e.id} does not convert to a valid attempt.`); continue; }
	attempts.push(a);
}
const ROLE: Record<string, Attempt["role"]> = { review: "attempt", retry: "retry", followup: "followup", check: "check" };
for (const r of reviews) {
	const conceptId = resolveKey(r.itemId);
	if (!graph.concepts[conceptId]) { problems.push(`Review ${r.id} names unknown concept ${conceptId}.`); continue; }
	const role = ROLE[r.kind];
	if (!role) { problems.push(`Review ${r.id} has unknown kind ${r.kind}.`); continue; }
	const consolidate = chats.get(r.chatId)?.settings?.consolidate === true;
	const { itemId: _i, kind: _k, ...rest } = r;
	const a = { ...rest, conceptId, source: consolidate ? "consolidate" : "review", role } as Attempt;
	if (!isAttempt(a)) { problems.push(`Review ${r.id} does not convert to a valid attempt.`); continue; }
	const derived = ratingFor(r as never);
	if (role === "attempt" && derived !== r.rating) notes.push(`Review ${r.id} (${conceptId}): stored rating ${r.rating}, the outcome now maps to ${derived}. Kept the stored rating.`);
	attempts.push(a);
}
attempts.sort((a, b) => a.at.localeCompare(b.at));
const ids = new Set<string>();
for (const a of attempts) { if (ids.has(a.id)) problems.push(`Duplicate attempt id ${a.id}.`); ids.add(a.id); }

// ─── chats and courses ───────────────────────────────────────────────────
const newChats = new Map<string, Json>();
for (const [chatId, map] of chatMaps) {
	const chat = chats.get(chatId)!;
	const goals = chat.settings?.timebox?.goals;
	const out = rewriteChat({ messages: chat.messages ?? [], ...(chat.tree ? { tree: chat.tree } : {}), ...(goals ? { goals } : {}) }, map);
	if (!out.changed) continue;
	const next: Json = { ...chat, messages: out.messages, ...(out.tree ? { tree: out.tree } : {}) };
	if (out.goals && chat.settings?.timebox) next.settings = { ...chat.settings, timebox: { ...chat.settings.timebox, goals: out.goals } };
	// Every id the rewritten chat names must be a concept (math) or untouched (non-math).
	for (const id of nodeIdsOfChat({ messages: next.messages, ...(next.tree ? { tree: next.tree } : {}) })) {
		if (!graph.concepts[id] && !map.has(id)) problems.push(`${chatId}: names "${id}" after the rewrite, which is no concept.`);
	}
	newChats.set(chatId, next);
}
const newCourses = courses.map((course: Json): Json => {
	const map = new Map<string, string>([...new Set([...(course.map?.nodes ?? []).map((n: Json) => n.id as string), ...(course.mapHistory ?? []).flatMap((h: Json) => h.tree.nodes.map((n: Json) => n.id as string))])].map((slug) => [slug, bySlug(slug)]));
	const { aliases: _a, ...rest } = course;
	return {
		...rest, format: COURSE_FORMAT,
		map: rewriteTree(course.map, map),
		mapHistory: (course.mapHistory ?? []).map((h: Json) => ({ ...h, tree: rewriteTree(h.tree, map) })),
		sittings: (course.sittings ?? []).map((s: Json) => ({ ...s, goals: (s.goals ?? []).map((g: Json) => ({ ...g, nodeIds: [...new Set((g.nodeIds ?? []).map((id: string) => map.get(id) ?? bySlug(id)))] })) })),
	};
});

// ─── verify ──────────────────────────────────────────────────────────────
const store: MathStore = {
	options: () => ({ implicitCredit: false }), saveOptions() {}, graph: () => graph, saveGraph() {}, attempts: () => attempts,
	appendAttempt() {}, unverified: () => unverified, rewriteConcept: () => 0, removeChat: () => 0,
};
const snapshot = memorySnapshot(graph, attempts, NOW, { unverified });
const snapById = new Map(snapshot.map((s) => [s.id, s]));
const oldKeys = new Map<string, string[]>(); // concept → old item keys
for (const e of evidence) { const id = chatMaps.get(e.chatId)?.get(e.nodeId) ?? resolve(e.chatId, e.nodeId); const key = `${e.chatId}#${e.nodeId}`; const l = oldKeys.get(id) ?? oldKeys.set(id, []).get(id)!; if (!l.includes(key)) l.push(key); }
for (const r of reviews) { const id = resolveKey(r.itemId); const l = oldKeys.get(id) ?? oldKeys.set(id, []).get(id)!; if (!l.includes(r.itemId)) l.push(r.itemId); }

const lines: string[] = [];
const fmt = (s: { state?: { stability: number }; retrievability?: number; dueAt?: string } | undefined) =>
	s?.state ? `R ${(s.retrievability! * 100).toFixed(0)}% · S ${s.state.stability.toFixed(1)}d · due ${s.dueAt?.slice(0, 10)}` : "unscheduled";
lines.push(`# Global-concepts migration report`, "", `From \`${FROM}\` → ${WRITE ? `\`${OUT}\`` : "dry run (nothing written)"} · now ${new Date(NOW).toISOString()}`, "");
lines.push(`## Counts`, "",
	`- Concepts: ${Object.keys(graph.concepts).length} (from ${[...seen.values()].reduce((n, l) => n + l.length, 0)} old pairs); global edges: ${graph.edges.length}`,
	`- Evidence: ${evidence.length} → ${attempts.filter((a) => a.source === "teach" || a.source === "probe").length} attempts (${attempts.filter((a) => a.source === "probe").length} probe) + ${unverified.length} unverified notes`,
	`- Reviews: ${reviews.length} → ${attempts.filter((a) => a.source === "review" || a.source === "consolidate").length} attempts`,
	`- Chats rewritten: ${newChats.size} of ${chats.size}; courses: ${newCourses.length} (format ${COURSE_FORMAT}, aliases removed)`,
	`- Memory items: ${snapshot.length} (${snapshot.filter((s) => s.state).length} scheduled, ${snapshot.filter((s) => s.due).length} due now)`, "");
lines.push(`## Problems (${problems.length})`, "", ...(problems.length ? problems.map((p) => `- ${p}`) : ["None."]), "");
lines.push(`## Merged concepts (${merged.length})`, "");
for (const m of merged) {
	lines.push(`- **${m.id}** (${graph.concepts[m.id]!.title}) ← ${m.pairs.map((p) => `\`${p.replace(/^chat_(\w{8})\w*#/, "$1#")}\``).join(", ")} — now ${fmt(snapById.get(m.id))}`);
}
lines.push("");
if (OLD_SNAPSHOT) {
	const old = JSON.parse(fs.readFileSync(OLD_SNAPSHOT, "utf-8")) as Record<string, { state?: { stability: number; difficulty: number }; retrievability?: number; dueAt?: string; status?: string }>;
	const same: string[] = [], diff: string[] = [], multi: string[] = [];
	for (const [id, keys] of [...oldKeys].sort(([a], [b]) => a.localeCompare(b))) {
		const now = snapById.get(id);
		if (keys.length !== 1) { multi.push(`- **${id}**: ${keys.map((k) => `\`${k.replace(/^chat_(\w{8})\w*#/, "$1#")}\` ${fmt(old[k])}`).join("; ")} → **${fmt(now)}**`); continue; }
		const o = old[keys[0]!];
		const eq = (!o?.state && !now?.state) || (o?.state && now?.state && Math.abs(o.state.stability - now.state.stability) < 1e-6 && Math.abs(o.state.difficulty - now.state.difficulty) < 1e-6);
		const why = !o?.state && now?.state && unverified.some((n) => n.conceptId === id)
			? " (intended: an `assumed` record no longer makes it conditional; it now seeds from its real attempts)"
			: o?.state && !now?.state ? " (BUG?)" : "";
		(eq ? same : diff).push(`- **${id}** (\`${keys[0]}\`): old ${fmt(o)} → new ${fmt(now)}${why}`);
	}
	lines.push(`## FSRS state: one old item → one concept`, "", `${same.length} identical, ${diff.length} different.`, "");
	if (diff.length) lines.push("Different (each one needs a reason):", "", ...diff, "");
	lines.push(`## FSRS state: several old items → one concept (${multi.length})`, "", "Expected to change: two histories are now one, and a later sitting's first attempt is a review.", "", ...multi, "");
}
lines.push(`## Notes (${notes.length})`, "", ...notes.map((n) => `- ${n}`), "");
lines.push(`## Concept ids`, "", ...Object.values(graph.concepts).map((c) => `- \`${c.id}\` [${c.kind}] ${c.title}`), "");
const report = lines.join("\n");
if (REPORT) fs.writeFileSync(REPORT, report, "utf-8");
console.log(REPORT ? `Report: ${REPORT}` : report);
console.log(`\n${problems.length} problem(s). ${WRITE ? "Writing…" : "Dry run: nothing written. Pass --write to create " + OUT + "."}`);

// ─── write ───────────────────────────────────────────────────────────────
if (WRITE) {
	if (problems.length) throw new Error("Refusing to write with problems; fix the concept map first.");
	if (!isConceptGraph(graph) || graph.format !== CONCEPTS_FORMAT) throw new Error("Built an invalid concept graph.");
	if (!unverified.every(isUnverifiedNote)) throw new Error("Built an invalid unverified note.");
	// Everything that does not change, verbatim; the old math logs are not copied.
	fs.cpSync(FROM, OUT, { recursive: true, filter: (src) => {
		const rel = path.relative(FROM, src).split(path.sep);
		return !(rel[0] === "evidence" || (rel[0] === "memory" && rel[1] === "reviews.jsonl"));
	} });
	const mathDir = path.join(OUT, "math");
	fs.mkdirSync(mathDir, { recursive: true });
	fs.writeFileSync(path.join(mathDir, "concepts.json"), JSON.stringify(graph, null, "\t"));
	fs.writeFileSync(path.join(mathDir, "attempts.jsonl"), attempts.map((a) => JSON.stringify(a)).join("\n") + "\n");
	fs.writeFileSync(path.join(mathDir, "unverified.jsonl"), unverified.map((n) => JSON.stringify(n)).join("\n") + (unverified.length ? "\n" : ""));
	fs.writeFileSync(path.join(mathDir, "merges.jsonl"), merged.map((m) => JSON.stringify({ at: new Date(NOW).toISOString(), into: m.id, from: m.pairs, reason: "migration to global concepts" })).join("\n") + (merged.length ? "\n" : ""));
	fs.writeFileSync(path.join(mathDir, "options.json"), JSON.stringify({ implicitCredit: false }, null, "\t"));
	const oldWeights = path.join(OUT, "memory", "fsrs-weights.json");
	if (fs.existsSync(oldWeights)) { fs.renameSync(oldWeights, path.join(mathDir, "fsrs-weights.json")); }
	if (fs.existsSync(path.join(OUT, "memory")) && fs.readdirSync(path.join(OUT, "memory")).length === 0) fs.rmdirSync(path.join(OUT, "memory"));
	for (const [id, chat] of newChats) fs.writeFileSync(path.join(OUT, "chats", `${id}.json`), JSON.stringify(chat, null, "\t"));
	for (const course of newCourses) fs.writeFileSync(path.join(OUT, "courses", `${course.id}.json`), JSON.stringify(course, null, "\t"));
	// Read back through the real validators.
	const back = JSON.parse(fs.readFileSync(path.join(mathDir, "concepts.json"), "utf-8"));
	if (!isConceptGraph(back)) throw new Error("concepts.json does not read back.");
	const backAttempts = readJsonl(path.join(mathDir, "attempts.jsonl"));
	if (backAttempts.length !== attempts.length || !backAttempts.every(isAttempt)) throw new Error("attempts.jsonl does not read back.");
	console.log(`Wrote ${OUT}.`);
}
void store;
