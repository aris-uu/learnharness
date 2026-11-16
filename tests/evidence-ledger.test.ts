import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import {
	backfillEvidence,
	evidenceRecordsFromChat,
	searchEvidence,
	type EvidenceRecord,
	type EvidenceStore,
} from "../src/core/math-evidence.ts";
import { createEvidenceStore } from "../src/store/evidence.ts";

function tempLedger(t: { after(fn: () => void): void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "evidence", "evidence.jsonl");
	return { file, store: createEvidenceStore(file) };
}

const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	id: "r", chatId: "c1", nodeId: "n", nodeTitle: "Node", dimension: "K", outcome: "correct",
	hints: 0, note: "note", recordedAt: "2026-11-01T00:00:00.000Z", ...over,
});

const tree = {
	nodes: [{ id: "lagrange", title: "Lagrange's theorem", summary: "Subgroup order divides group order" }, { id: "b", title: "B" }],
	edges: [{ from: "lagrange", to: "b" }],
	version: 1,
};

function chatWithEvidence(id: string) {
	return {
		id,
		title: `Session ${id}`,
		updatedAt: "2026-11-02T00:00:00.000Z",
		tree,
		messages: [
			{ role: "assistant", timestamp: Date.parse("2026-11-01T10:00:00.000Z"), content: [
				{ type: "toolCall", id: `${id}-ok`, name: "record_evidence", arguments: { nodeId: "lagrange", dimension: "K", outcome: "correct", hints: 0, note: "stated it" } },
				{ type: "toolCall", id: `${id}-bad`, name: "record_evidence", arguments: { nodeId: "lagrange", dimension: "U", outcome: "correct", hints: 0, note: "refused" } },
			] },
			{ role: "toolResult", toolCallId: `${id}-ok`, toolName: "record_evidence", content: [{ type: "text", text: "{}" }] },
			{ role: "toolResult", toolCallId: `${id}-bad`, toolName: "record_evidence", isError: true, content: [{ type: "text", text: "no" }] },
		],
	};
}

describe("evidence ledger store", () => {
	it("appends, dedupes by id, skips corrupt lines, and removes one chat", (t) => {
		const { file, store } = tempLedger(t);
		assert.equal(store.exists(), false);
		assert.deepEqual(store.list(), []);
		store.append(record({ id: "a", chatId: "c1" }));
		store.append(record({ id: "a", chatId: "c1", note: "duplicate" }));
		store.append(record({ id: "b", chatId: "c2" }));
		fs.appendFileSync(file, "not json\n{\"id\":\"x\"}\n");
		assert.equal(store.exists(), true);
		assert.deepEqual(store.list().map((r) => [r.id, r.note]), [["a", "note"], ["b", "note"]]);
		assert.equal(store.removeChat("c1"), 1);
		assert.deepEqual(store.list().map((r) => r.id), ["b"]);
		assert.equal(store.removeChat("missing"), 0);
	});
});

describe("evidence backfill", () => {
	it("seeds successful calls once, with node text and the calling message's time", (t) => {
		const { store } = tempLedger(t);
		const chats = [chatWithEvidence("c1"), chatWithEvidence("c2")];
		const chatStore = { listChats: () => chats, getChat: (id: string) => chats.find((c) => c.id === id) ?? null };
		assert.equal(backfillEvidence(chatStore, store), 2);
		const [first] = store.list();
		assert.equal(first!.nodeTitle, "Lagrange's theorem");
		assert.equal(first!.nodeSummary, "Subgroup order divides group order");
		assert.equal(first!.recordedAt, "2026-11-01T10:00:00.000Z");
		assert.equal(backfillEvidence(chatStore, store), null, "never runs twice");
	});
	it("writes an empty ledger when there is nothing to seed", (t) => {
		const { store } = tempLedger(t);
		assert.equal(backfillEvidence({ listChats: () => [], getChat: () => null }, store), 0);
		assert.equal(store.exists(), true);
	});
	it("falls back to the node id when the plan no longer has the node", () => {
		const chat = { ...chatWithEvidence("c1"), tree: { nodes: [], edges: [], version: 2 } };
		assert.equal(evidenceRecordsFromChat(chat)[0]!.nodeTitle, "lagrange");
	});
});

describe("evidence search", () => {
	const records = [
		record({ id: "1", chatId: "old", nodeId: "lag", nodeTitle: "Lagrange's theorem", note: "stated it", recordedAt: "2026-10-01T00:00:00.000Z" }),
		record({ id: "2", chatId: "old", nodeId: "lag", nodeTitle: "Lagrange's theorem", dimension: "S", note: "used it on a group of order 15", recordedAt: "2026-10-02T00:00:00.000Z" }),
		record({ id: "3", chatId: "other", nodeId: "fermat", nodeTitle: "Fermat's little theorem", nodeSummary: "a corollary of Lagrange", recordedAt: "2026-10-03T00:00:00.000Z" }),
		record({ id: "4", chatId: "current", nodeId: "lag", nodeTitle: "Lagrange's theorem" }),
	];
	it("ranks by terms matched, then newest; leaves out the current chat", () => {
		const hits = searchEvidence(records, "Lagrange theorem group", "current")!;
		assert.deepEqual(hits.map((h) => h.record.id), ["2", "3", "1"]);
		assert.ok(hits.every((h) => h.record.chatId !== "current"));
	});
	it("reports each node's status within its own session", () => {
		const hits = searchEvidence(records, "lagrange", "current")!;
		assert.equal(hits.find((h) => h.record.id === "1")!.nodeStatus, "solid");
		assert.equal(hits.find((h) => h.record.id === "3")!.nodeStatus, "in_progress");
	});
	it("returns null for a query with no searchable word, and caps results", () => {
		assert.equal(searchEvidence(records, "a ?", "current"), null);
		assert.equal(searchEvidence(records, "theorem", "current", 1)!.length, 1);
	});
});

describe("evidence tools", () => {
	function memoryStore(): EvidenceStore & { records: EvidenceRecord[] } {
		const records: EvidenceRecord[] = [];
		return {
			records,
			exists: () => true,
			list: () => [...records],
			append: (r) => { records.push(r); },
			replaceAll: (rs) => { records.splice(0, records.length, ...rs); },
			removeChat: () => 0,
		};
	}
	const chat = { messages: [] as unknown[], tree };
	const ctxWith = (evidenceStore?: EvidenceStore) => ({
		chatId: "now",
		chatStore: { getChat: () => chat, listChats: () => [{ id: "old", title: "Group theory" }] },
		jobStore: {}, spawn: () => {}, searchAvailable: () => false,
		...(evidenceStore ? { evidenceStore } : {}),
	}) as never;

	it("offers search_evidence to the prober and teacher in math mode only", () => {
		const store = memoryStore();
		assert.ok(createTeacherTools(ctxWith(store), undefined, "math").search_evidence);
		assert.ok(createProberTools(ctxWith(store), undefined, "math").search_evidence);
		assert.equal(createTeacherTools(ctxWith(store)).search_evidence, undefined);
		assert.equal(createProberTools(ctxWith(store)).search_evidence, undefined);
		assert.equal(createTeacherTools(ctxWith(), undefined, "math").search_evidence, undefined);
	});
	it("copies a successful record_evidence call into the ledger, and not a refused one", async () => {
		const store = memoryStore();
		const tools = createTeacherTools(ctxWith(store), undefined, "math");
		await tools.record_evidence!.execute("refused", { nodeId: "lagrange", dimension: "K", outcome: "correct", hints: 0, note: "n" });
		await tools.record_evidence!.execute("ok", { nodeId: "lagrange", dimension: "K", outcome: "assumed", hints: 0, note: "probe" });
		assert.deepEqual(store.records.map((r) => [r.id, r.chatId, r.nodeTitle]), [["ok", "now", "Lagrange's theorem"]]);
	});
	it("search_evidence returns other sessions' evidence with the session title", async () => {
		const store = memoryStore();
		store.records.push(record({ id: "x", chatId: "old", nodeTitle: "Lagrange's theorem" }), record({ id: "y", chatId: "now", nodeTitle: "Lagrange's theorem" }));
		const tools = createProberTools(ctxWith(store), undefined, "math");
		const result = await tools.search_evidence!.execute("s", { query: "lagrange" });
		const details = result.details as { count: number; results: Array<{ session: string; nodeStatusInSession: string }> };
		assert.equal(details.count, 1);
		assert.equal(details.results[0]!.session, "Group theory");
		assert.equal(details.results[0]!.nodeStatusInSession, "in progress");
		const empty = await tools.search_evidence!.execute("s2", { query: "?" });
		assert.equal(empty.isError, true);
	});
});
