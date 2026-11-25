import { test } from "node:test";
import assert from "node:assert/strict";
import {
	courseItemKeys, courseNodeViews, courseSeed, emptyCourse, mapFromMatches, matchTableProblems, proposeNodeMatches, reconstructedHandoff,
	type CourseRecord, type CourseStore, type NodeMatchRow,
} from "../src/core/course.ts";
import { courseOfChat, ensureCourseForChat, seedForChat, startCourseSitting, syncSitting, ungroupChat, type CoursePorts } from "../src/core/course-ops.ts";
import { memoryItems } from "../src/core/memory/items.ts";
import type { EvidenceRecord } from "../src/core/math-evidence.ts";

const NOW = "2026-11-23T10:00:00.000Z";

function memoryCourses(): CourseStore {
	const byId = new Map<string, CourseRecord>();
	return {
		list: () => [...byId.values()].map((c) => structuredClone(c)),
		get: (id) => (byId.has(id) ? structuredClone(byId.get(id)!) : null),
		save: (course) => { byId.set(course.id, structuredClone(course)); },
		delete: (id) => byId.delete(id),
	};
}

function fakeChats(chats: any[]) {
	const byId = new Map(chats.map((c) => [c.id, c]));
	return {
		getChat: (id: string) => byId.get(id) ?? null,
		listChats: () => [...byId.values()],
		saveSettings: (id: string, settings: unknown) => { byId.get(id)!.settings = settings; },
		saveTree: (id: string, tree: unknown) => { byId.get(id)!.tree = tree; },
		add: (chat: any) => byId.set(chat.id, chat),
	} as any;
}

const record = (chatId: string, nodeId: string, dimension: string, outcome = "correct", habits?: string[]): EvidenceRecord => ({
	id: `${chatId}-${nodeId}-${dimension}-${outcome}`, chatId, nodeId, nodeTitle: nodeId, dimension, outcome, hints: 0, note: "n", recordedAt: NOW, ...(habits ? { habits } : {}),
} as unknown as EvidenceRecord);

function ports(chats: any[], evidence: EvidenceRecord[] = []): CoursePorts & { chatStore: any } {
	return {
		chatStore: fakeChats(chats),
		courseStore: memoryCourses(),
		evidenceStore: { list: () => evidence, exists: () => true, append: () => {}, replaceAll: () => {}, removeChat: () => 0 },
		now: () => Date.parse(NOW),
	};
}

const tree = (...ids: Array<[string, string]>) => ({ nodes: ids.map(([id, title]) => ({ id, title })), edges: [] as Array<{ from: string; to: string }>, version: 1 });
const userMessage = (text: string) => ({ id: "m1", role: "user", content: text, timestamp: Date.parse(NOW) });

test("item keys: a chat outside every course keeps its own key; a sitting maps through aliases onto the course", () => {
	const course: CourseRecord = { ...emptyCourse({ id: "crs_x", title: "PDE", nowIso: NOW }), aliases: { "old#transport-eq": "transport" }, sittings: [{ chatId: "old", startedAt: NOW, goals: [] }, { chatId: "new", startedAt: NOW, goals: [] }] };
	const keys = courseItemKeys([course]);
	assert.deepEqual(keys.key("loose", "a"), { id: "loose#a", nodeId: "a" });
	assert.equal(keys.key("old", "transport-eq").id, "crs_x#transport");
	assert.equal(keys.key("new", "transport").id, "crs_x#transport");
	assert.equal(keys.courseOf("new"), "crs_x");
	// Stored review item ids from before the course resolve to the course item.
	assert.equal(keys.itemId("old#transport-eq"), "crs_x#transport");
	assert.equal(keys.itemId("crs_x#transport"), "crs_x#transport");
});

test("memory items: two sittings' evidence on one course node is one item", () => {
	const course: CourseRecord = { ...emptyCourse({ id: "crs_x", title: "PDE", nowIso: NOW }), aliases: { "old#t": "transport" }, sittings: [{ chatId: "old", startedAt: NOW, goals: [] }, { chatId: "new", startedAt: NOW, goals: [] }] };
	const items = memoryItems([record("old", "t", "K"), record("new", "transport", "S")], [], undefined, courseItemKeys([course]));
	assert.equal(items.length, 1);
	assert.equal(items[0]!.id, "crs_x#transport");
	assert.equal(items[0]!.courseId, "crs_x");
});

test("node views: done needs solid evidence, stale is solid with low recall, started is attempted", () => {
	const course = emptyCourse({ title: "T", nowIso: NOW, map: tree(["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]) });
	const facts = new Map([
		["a", { solid: true, attempted: true, stale: false, habits: [] }],
		["b", { solid: true, attempted: true, stale: true, habits: [] }],
		["c", { solid: false, attempted: true, stale: false, habits: ["sign_slip", "sign_slip"] }],
	]);
	const views = courseNodeViews(course, facts);
	assert.deepEqual(views.map((v) => v.state), ["done", "stale", "started", "later"]);
	assert.deepEqual(views[2]!.habits, ["sign_slip"]);
});

test("ensureCourseForChat: a session becomes a course of one with its first message as the source", () => {
	const p = ports([{ id: "c1", title: "Transport PDE", createdAt: NOW, messages: [userMessage("Problem set: see `D:/sets/pde.png`")], tree: tree(["a", "A"]), settings: { timeboxMin: 60 } }]);
	const course = ensureCourseForChat(p, "c1")!;
	assert.equal(course.title, "Transport PDE");
	assert.equal(course.sources[0]!.text.startsWith("Problem set"), true);
	assert.deepEqual(course.sources[0]!.attachments, ["D:/sets/pde.png"]);
	assert.equal(course.map.nodes.length, 1);
	assert.equal(p.chatStore.getChat("c1").settings.courseId, course.id);
	assert.equal(ensureCourseForChat(p, "c1")!.id, course.id, "idempotent");
});

test("startCourseSitting: the next chat joins the course, gets the map, and its seed is a continuation", () => {
	const p = ports([
		{ id: "c1", title: "Transport PDE", createdAt: NOW, messages: [userMessage("All 8 problems")], tree: tree(["p1", "Problem 1"], ["p2", "Problem 2"]), settings: { timeboxMin: 60, timebox: { closedAt: NOW, handoff: "p1 holds; p2 fragile.", goals: [{ id: "g1", text: "Solve problem 2", nodeIds: ["p2"], status: "partial" }] } } },
		{ id: "c2", title: "Next", createdAt: NOW, messages: [], settings: {} },
	], [record("c1", "p1", "K"), record("c1", "p1", "S")]);
	const course = startCourseSitting(p, "c2", "c1")!;
	assert.deepEqual(course.sittings.map((s) => s.chatId), ["c1", "c2"]);
	assert.equal(p.chatStore.getChat("c2").tree.nodes.length, 2);
	assert.equal(courseOfChat(p, "c2")!.id, course.id);
	const seed = seedForChat(p, "c2")!;
	assert.equal(seed.continuation, true);
	assert.match(seed.seed, /All 8 problems/);
	assert.match(seed.seed, /✓ `p1`/);
	assert.match(seed.seed, /p1 holds; p2 fragile/);
	assert.match(seed.seed, /Solve problem 2 \(partial\)/);
	assert.equal(seedForChat(p, "c1")!.continuation, false);
});

test("seed excludes the running sitting's own evidence, so it stays stable within a sitting", () => {
	const evidence: EvidenceRecord[] = [];
	const p = ports([{ id: "c1", title: "T", createdAt: NOW, messages: [], tree: tree(["a", "A"]), settings: {} }], evidence);
	ensureCourseForChat(p, "c1");
	const before = seedForChat(p, "c1")!.seed;
	evidence.push(record("c1", "a", "K"), record("c1", "a", "S"));
	assert.equal(seedForChat(p, "c1")!.seed, before);
});

test("syncSitting copies goals and the close; a reconstructed hand-off survives until a real close", () => {
	const chat: any = { id: "c1", title: "Old", createdAt: NOW, messages: [userMessage("hi"), { id: "m2", role: "assistant", content: [{ type: "text", text: "Last thing said" }] }], tree: tree(["a", "A"]), settings: {} };
	const p = ports([chat]);
	const course = ensureCourseForChat(p, "c1", { reconstruct: true })!;
	assert.equal(course.sittings[0]!.handoffSource, "reconstructed");
	chat.settings = { ...chat.settings, timebox: { goals: [{ id: "g1", text: "A", nodeIds: ["a"], status: "open" }] } };
	let synced = syncSitting(p, "c1")!;
	assert.equal(synced.sittings[0]!.goals.length, 1);
	assert.equal(synced.sittings[0]!.handoffSource, "reconstructed");
	chat.settings.timebox = { ...chat.settings.timebox, closedAt: NOW, handoff: "real" };
	synced = syncSitting(p, "c1")!;
	assert.equal(synced.sittings[0]!.handoff, "real");
	assert.equal(synced.sittings[0]!.handoffSource, "close");
});

test("matching: similar titles are proposed as merges, the rest stay separate", () => {
	const rows = proposeNodeMatches([
		{ chatId: "c1", tree: tree(["transport-eq", "Transport equation"], ["chars", "Method of characteristics"]) },
		{ chatId: "c2", tree: tree(["transport", "The transport equation"], ["burgers", "Burgers equation"]) },
	]);
	const merged = rows.find((r) => r.action === "merge")!;
	assert.deepEqual(merged.from, { c1: "transport-eq", c2: "transport" });
	assert.equal(rows.filter((r) => r.action === "separate").length, 2);
});

test("matching table: bad ids and double claims are refused; the map carries remapped edges", () => {
	const chats = [
		{ chatId: "c1", tree: { ...tree(["a", "A"], ["b", "B"]), edges: [{ from: "a", to: "b" }] } },
		{ chatId: "c2", tree: { ...tree(["a2", "A"], ["c", "C"]), edges: [{ from: "a2", to: "c" }] } },
	];
	const bad = [{ courseNodeId: "Bad Id", title: "A", from: { c1: "a", c2: "nope" }, action: "merge" as const, reason: "" }];
	assert.equal(matchTableProblems(bad, chats).length, 2);
	const rows: NodeMatchRow[] = [
		{ courseNodeId: "a", title: "A", from: { c1: "a", c2: "a2" }, action: "merge" as const, reason: "" },
		{ courseNodeId: "b", title: "B", from: { c1: "b" }, action: "separate" as const, reason: "" },
		{ courseNodeId: "c", title: "C", from: { c2: "c" }, action: "drop" as const, reason: "" },
	];
	assert.deepEqual(matchTableProblems(rows, chats), []);
	const { map, aliases } = mapFromMatches(rows, chats);
	assert.deepEqual(map.nodes.map((n) => n.id), ["a", "b"]);
	assert.deepEqual(map.edges, [{ from: "a", to: "b" }]);
	assert.equal(aliases["c2#a2"], "a");
	assert.equal(aliases["c2#c"], undefined);
});

test("ungroupChat removes the sitting and its aliases and deletes an empty course", () => {
	const p = ports([{ id: "c1", title: "T", createdAt: NOW, messages: [], tree: tree(["a", "A"]), settings: {} }]);
	const course = ensureCourseForChat(p, "c1")!;
	p.courseStore.save({ ...course, aliases: { "c1#a": "a" } });
	assert.equal(ungroupChat(p, course.id, "c1"), null);
	assert.equal(p.courseStore.get(course.id), null);
	assert.equal(p.chatStore.getChat("c1").settings.courseId, undefined);
});

test("reconstructed hand-off names what holds, what is fragile, and where it stopped", () => {
	const text = reconstructedHandoff({
		title: "Hyperbolic geometry",
		views: [{ title: "Upper half-plane", state: "done", habits: [] }, { title: "Geodesics", state: "started", habits: ["unjustified_step"] }],
		lastNodeTitle: "Geodesics",
		pendingQuestion: "Why are vertical lines geodesics?",
	});
	assert.match(text, /Upper half-plane/);
	assert.match(text, /Geodesics/);
	assert.match(text, /unjustified_step/);
	assert.match(text, /Why are vertical lines geodesics\?/);
});

test("course seed without a digest lists the sources and asks for record_digest", () => {
	const course = { ...emptyCourse({ title: "Conjugation", nowIso: NOW }), sources: [{ chatId: "c1", messageId: "m1", text: "Syllabus: ...", attachments: [] }] };
	const seed = courseSeed({ course, chatId: "c1", views: [], sittingTitle: (id) => id });
	assert.match(seed, /record_digest/);
	assert.match(seed, /Syllabus/);
	const digested = courseSeed({ course: { ...course, digest: "1. Groups 2. Conjugacy" }, chatId: "c1", views: [], sittingTitle: (id) => id });
	assert.match(digested, /Sources \(digest\)/);
	assert.doesNotMatch(digested, /Syllabus/);
});
