/** An in-memory MathStore for tests (no files). */
import { DEFAULT_MATH_OPTIONS, emptyConceptGraph, type Attempt, type Concept, type ConceptGraph, type MathOptions, type MathStore, type UnverifiedNote } from "../src/core/math-concepts.ts";

export function memoryMathStore(init: { graph?: ConceptGraph; attempts?: Attempt[]; unverified?: UnverifiedNote[]; options?: Partial<MathOptions> } = {}): MathStore & { appended: Attempt[] } {
	let graph = init.graph ?? emptyConceptGraph();
	let attempts = [...(init.attempts ?? [])];
	let unverified = [...(init.unverified ?? [])];
	let options: MathOptions = { ...DEFAULT_MATH_OPTIONS, ...init.options };
	const appended: Attempt[] = [];
	return {
		appended,
		options: () => options,
		saveOptions: (next) => { options = next; },
		graph: () => graph,
		saveGraph: (next) => { graph = next; },
		attempts: () => attempts,
		appendAttempt: (a) => { attempts = [...attempts, a]; appended.push(a); },
		unverified: () => unverified,
		rewriteConcept: (from, into) => {
			let n = 0;
			attempts = attempts.map((a) => (a.conceptId === from ? (n++, { ...a, conceptId: into }) : a));
			unverified = unverified.map((u) => (u.conceptId === from ? { ...u, conceptId: into } : u));
			return n;
		},
		removeChat: (chatId) => { const before = attempts.length; attempts = attempts.filter((a) => a.chatId !== chatId); return before - attempts.length; },
	};
}

/** A confirmed concept (not a migration draft). */
export function concept(id: string, extra: Partial<Concept> = {}): Concept {
	return { id, title: id.toUpperCase(), kind: "definition", statement: `The full statement of ${id}, every clause.`, createdAt: "2026-11-01T00:00:00.000Z", createdIn: "old", status: "active", ...extra };
}

export function graphOf(concepts: Concept[], edges: Array<{ from: string; to: string }> = []): ConceptGraph {
	return { format: 1, concepts: Object.fromEntries(concepts.map((c) => [c.id, c])), edges: edges.map((e) => ({ ...e, addedIn: "old" })) };
}

let n = 0;
/** A graded attempt; rating is derived the way the tools derive it unless given. */
export function attempt(conceptId: string, at: string, extra: Partial<Attempt> = {}): Attempt {
	const outcome = extra.outcome ?? "correct";
	const hints = extra.hints ?? 0;
	const rating = extra.rating ?? (outcome === "incorrect" || hints >= 2 ? 1 : outcome === "partial" ? 1 : outcome === "correct_slow" || hints === 1 ? 2 : 3);
	return { id: `att${++n}`, conceptId, chatId: "old", at, source: "teach", role: "attempt", dimension: "K", outcome, hints, note: "n", rating, ...extra };
}
