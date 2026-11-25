/**
 * search_evidence over the global concept graph (docs/global-concepts-plan.md):
 * concepts are shared by every session, so a search returns the concept, its
 * mastery from the whole attempt log, and its memory.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { searchConcepts } from "../src/core/math-concepts.ts";
import { attempt, concept, graphOf, memoryMathStore } from "./math-store-fixture.ts";

const graph = graphOf([
	concept("lagrange", { title: "Lagrange's theorem", summary: "Subgroup order divides group order" }),
	concept("lagrange-corollary", { title: "Lagrange corollary" }),
	concept("cauchy", { title: "Cauchy's theorem" }),
]);

describe("concept search", () => {
	it("ranks by terms matched, and returns null for a query with no searchable word", () => {
		assert.deepEqual(searchConcepts(graph, "lagrange subgroup")!.map((c) => c.id), ["lagrange", "lagrange-corollary"]);
		assert.equal(searchConcepts(graph, "a ?"), null);
		assert.equal(searchConcepts(graph, "theorem", 1)!.length, 1);
	});
});

describe("search_evidence tool", () => {
	const chat = { messages: [] as unknown[] };
	const ctxWith = (mathStore?: ReturnType<typeof memoryMathStore>) => ({
		chatId: "now",
		chatStore: { getChat: () => chat, listChats: () => [{ id: "old", title: "Group theory" }] },
		jobStore: {}, spawn: () => {}, searchAvailable: () => false,
		...(mathStore ? { mathStore } : {}),
	}) as never;

	it("is offered to the prober and teacher in math mode only", () => {
		const store = memoryMathStore({ graph });
		assert.ok(createTeacherTools(ctxWith(store), undefined, "math").search_evidence);
		assert.ok(createProberTools(ctxWith(store), undefined, "math").search_evidence);
		assert.equal(createTeacherTools(ctxWith(store)).search_evidence, undefined);
		assert.equal(createTeacherTools(ctxWith(), undefined, "math").search_evidence, undefined);
	});

	it("returns each concept's id, mastery, last notes with the session title, and memory", async () => {
		const old = "2025-01-01T00:00:00.000Z";
		const store = memoryMathStore({
			graph,
			attempts: [attempt("lagrange", old), attempt("lagrange", old, { dimension: "U" })],
			unverified: [{ id: "u", conceptId: "lagrange-corollary", chatId: "old", at: old, dimension: "K", note: "claimed" }],
		});
		const tools = createProberTools(ctxWith(store), undefined, "math");
		const result = await tools.search_evidence!.execute("s", { query: "lagrange" });
		const details = result.details as { results: Array<{ id: string; mastery: string; lastNotes: Array<{ session: string }>; memory: { recall?: number; stale?: boolean; unverified?: boolean } }> };
		const solid = details.results.find((r) => r.id === "lagrange")!;
		assert.equal(solid.mastery, "solid");
		assert.equal(solid.lastNotes[0]!.session, "Group theory");
		assert.equal(solid.memory.stale, true);
		assert.ok(solid.memory.recall! < 0.85);
		assert.deepEqual(details.results.find((r) => r.id === "lagrange-corollary")!.memory, { unverified: true });
		const empty = await tools.search_evidence!.execute("s2", { query: "?" });
		assert.equal(empty.isError, true);
	});
});
