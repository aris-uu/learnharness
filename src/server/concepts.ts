/**
 * Concept operations over the wired stores (docs/global-concepts-plan.md):
 * merge (a direct rewrite of every reference, no alias), retire/unretire and
 * the math options. The Memory page and course grouping call these.
 */
import { rewriteChat, nodeIdsOfChat } from "../core/concept-rewrite.ts";
import { mergeInGraph, type ConceptGraph, type MathOptions } from "../core/math-concepts.ts";
import { rewriteTree } from "../core/concept-rewrite.ts";
import type { ChatSettings } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { stores } from "./stores.ts";

export class ConceptError extends Error {}

/**
 * Merge concept `from` into `into`: the attempt log, the concept graph, every
 * chat that names `from` (tree, tool-call arguments, goals) and every course
 * map are rewritten, and one audit line goes to math/merges.jsonl. `into`
 * keeps its own scope.
 */
export function mergeConcepts(from: string, into: string, options: { reason?: string } = {}): { attempts: number; chats: string[]; courses: string[] } {
	if (from === into) throw new ConceptError("A concept cannot be merged into itself.");
	const graph = stores.mathStore.graph();
	// Standard-mode plan nodes are not concepts: grouping still renames them in chats and courses.
	const concepts = !!graph.concepts[from];
	if (concepts && !graph.concepts[into]) throw new ConceptError(`No concept "${into}".`);
	const map = new Map([[from, into]]);
	const chats: string[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const chat = stores.chatStore.getChat(summary.id);
		if (!chat || !nodeIdsOfChat(chat).has(from)) continue;
		const goals = chat.settings?.timebox?.goals;
		const out = rewriteChat({ messages: chat.messages, ...(chat.tree ? { tree: chat.tree } : {}), ...(goals ? { goals: goals as never } : {}) }, map);
		if (!out.changed) continue;
		stores.chatStore.saveMessages(chat.id, out.messages as LhMessage[]);
		if (out.tree) stores.chatStore.saveTree(chat.id, out.tree);
		if (out.goals && chat.settings?.timebox) {
			const settings: ChatSettings = { ...chat.settings, timebox: { ...chat.settings.timebox, goals: out.goals as never } };
			stores.chatStore.saveSettings(chat.id, settings);
		}
		chats.push(chat.id);
	}
	const courses: string[] = [];
	for (const course of stores.courseStore.list()) {
		const names = course.map.nodes.some((n) => n.id === from) || course.mapHistory.some((h) => h.tree.nodes.some((n) => n.id === from)) ||
			course.sittings.some((s) => s.goals.some((g) => g.nodeIds.includes(from)));
		if (!names) continue;
		stores.courseStore.save({
			...course,
			map: rewriteTree(course.map, map),
			mapHistory: course.mapHistory.map((h) => ({ ...h, tree: rewriteTree(h.tree, map) })),
			sittings: course.sittings.map((s) => ({ ...s, goals: s.goals.map((g) => ({ ...g, nodeIds: [...new Set(g.nodeIds.map((id) => (id === from ? into : id)))] })) })),
			updatedAt: new Date().toISOString(),
		});
		courses.push(course.id);
	}
	if (!concepts) return { attempts: 0, chats, courses };
	const attempts = stores.mathStore.rewriteConcept(from, into);
	stores.mathStore.saveGraph(mergeInGraph(stores.mathStore.graph(), from, into));
	stores.mathStore.logMerge({ at: new Date().toISOString(), from, into, fromConcept: graph.concepts[from], attempts, chats, courses, ...(options.reason ? { reason: options.reason } : {}) });
	return { attempts, chats, courses };
}

export function setConceptRetired(id: string, retired: boolean): void {
	const graph: ConceptGraph = stores.mathStore.graph();
	const concept = graph.concepts[id];
	if (!concept) throw new ConceptError(`No concept "${id}".`);
	stores.mathStore.saveGraph({ ...graph, concepts: { ...graph.concepts, [id]: { ...concept, status: retired ? "retired" : "active" } } });
}

export function readMathOptions(): MathOptions {
	return stores.mathStore.options();
}

export function saveMathOptions(next: Partial<MathOptions>): MathOptions {
	const merged = { ...stores.mathStore.options(), ...(typeof next.implicitCredit === "boolean" ? { implicitCredit: next.implicitCredit } : {}) };
	stores.mathStore.saveOptions(merged);
	return merged;
}

/** Concept ids other chats' plans and courses still name (kept when a chat is deleted). */
export function referencedConcepts(exceptChatId: string): Set<string> {
	const ids = new Set<string>();
	for (const summary of stores.chatStore.listChats()) {
		if (summary.id === exceptChatId) continue;
		for (const node of stores.chatStore.getChat(summary.id)?.tree?.nodes ?? []) ids.add(node.id);
	}
	for (const course of stores.courseStore.list()) for (const node of course.map.nodes) ids.add(node.id);
	return ids;
}
