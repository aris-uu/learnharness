/**
 * Read a migrated data folder through the app's own stores (LH_DATA_DIR) and
 * check it: chats load, math node ids are concepts, statuses per sitting.
 *   LH_DATA_DIR=<data.migrated> npx tsx scripts/migration/verify-migrated.ts <old data dir>
 */
import fs from "node:fs";
import path from "node:path";
import { chatStore } from "../../src/store/chats.ts";
import { mathStore } from "../../src/store/math.ts";
import { courseStore } from "../../src/store/courses.ts";
import { nodeIdsOfChat } from "../../src/core/concept-rewrite.ts";
import { nodeStatus } from "../../src/core/math-evidence.ts";
import { asEvidence, storeSnapshot } from "../../src/core/memory/items.ts";

const OLD = process.argv[2]!;
const problems: string[] = [];
const graph = mathStore.graph();
const attempts = mathStore.attempts();
const chats = chatStore.listChats();
let loaded = 0;
const mathChats = new Set(attempts.map((a) => a.chatId));
for (const summary of chats) {
	const chat = chatStore.getChat(summary.id);
	if (!chat) { problems.push(`${summary.id} does not load`); continue; }
	loaded++;
	const math = chat.settings?.profile === "math" || chat.kind === "review" || mathChats.has(chat.id);
	if (!math) continue;
	for (const id of nodeIdsOfChat(chat)) if (!graph.concepts[id]) problems.push(`${chat.id} (${chat.title}) names "${id}", not a concept`);
}
// Plan statuses per sitting: old (evidence minus assumed, old slug) vs new (attempts, concept id).
const old = fs.readFileSync(path.join(OLD, "evidence", "evidence.jsonl"), "utf-8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const byIdOld = new Map(old.map((e) => [e.id, e]));
let same = 0; const diff: string[] = [];
const pairs = new Map<string, { chatId: string; conceptId: string; slugs: Set<string> }>();
for (const a of attempts) {
	if (a.source !== "teach" && a.source !== "probe") continue;
	const e = byIdOld.get(a.id);
	const key = `${a.chatId}#${a.conceptId}`;
	const p = pairs.get(key) ?? pairs.set(key, { chatId: a.chatId, conceptId: a.conceptId, slugs: new Set() }).get(key)!;
	if (e) p.slugs.add(e.nodeId);
}
for (const p of pairs.values()) {
	const now = nodeStatus(p.conceptId, attempts.filter((a) => a.chatId === p.chatId && a.conceptId === p.conceptId).map(asEvidence));
	const before = [...p.slugs].map((slug) => nodeStatus(slug, old.filter((e) => e.chatId === p.chatId && e.nodeId === slug && e.outcome !== "assumed")));
	if (before.length === 1 && before[0] === now) same++;
	else diff.push(`${p.chatId.slice(5, 13)} ${p.conceptId}: ${[...p.slugs].join("+")} ${before.join("/")} → ${now}`);
}
const snapshot = storeSnapshot(mathStore, Date.parse("2026-11-25T12:00:00Z"));
const courses = courseStore.list();
console.log(JSON.stringify({ chats: chats.length, loaded, concepts: Object.keys(graph.concepts).length, edges: graph.edges.length, attempts: attempts.length, unverified: mathStore.unverified().length, items: snapshot.length, due: snapshot.filter((s) => s.due).length, stages: snapshot.reduce<Record<string, number>>((m, s) => ({ ...m, [s.stage]: (m[s.stage] ?? 0) + 1 }), {}), courses: courses.map((c) => `${c.id} format ${c.format} nodes ${c.map.nodes.length}`), statusesSame: same, statusesDiff: diff, problems }, null, 1));
