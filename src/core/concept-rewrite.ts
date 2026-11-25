/**
 * Rewriting concept ids inside a chat record (docs/global-concepts-plan.md):
 * a concept merge, and the one-time migration, change ids DIRECTLY rather
 * than keeping an alias. Only structural places change: the plan tree,
 * tool-call arguments that name nodes (explain / recall / quiz /
 * record_evidence / record_review / pick_items / set_goals / plan_init,
 * including its mermaid text), plan_init's result tree, and the sitting's
 * goals. Thinking, prose and learner answers are never touched. Pure.
 */
import type { PlanTree } from "./contracts/plan.ts";
import { rewriteMermaidIds } from "./math-concepts.ts";

type Block = { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role?: string; content?: unknown; toolName?: string; details?: unknown };

/** Rename node ids in a tree: nodes that collapse onto one id keep the first, self-loops and duplicate edges go. */
export function rewriteTree(tree: PlanTree, map: ReadonlyMap<string, string>): PlanTree {
	const to = (id: string) => map.get(id) ?? id;
	const seen = new Set<string>();
	const nodes = tree.nodes.flatMap((n) => {
		const id = to(n.id);
		if (seen.has(id)) return [];
		seen.add(id);
		return [{ ...n, id }];
	});
	const edgeSeen = new Set<string>();
	const edges = tree.edges.flatMap((e) => {
		const from = to(e.from), target = to(e.to);
		const key = `${from}>${target}`;
		if (from === target || edgeSeen.has(key)) return [];
		edgeSeen.add(key);
		return [{ from, to: target }];
	});
	return { ...tree, nodes, edges };
}

const NODE_ARG_TOOLS = new Set(["explain", "recall", "quiz", "record_evidence", "record_review", "ask_user_question"]);

function rewriteArgs(block: Block, map: ReadonlyMap<string, string>): Record<string, unknown> | null {
	const args = block.arguments;
	if (!args || typeof args !== "object") return null;
	const to = (v: unknown) => (typeof v === "string" ? map.get(v) ?? v : v);
	let next: Record<string, unknown> | null = null;
	const set = (key: string, value: unknown) => {
		if (value === args[key]) return;
		next ??= { ...args };
		next[key] = value;
	};
	if (NODE_ARG_TOOLS.has(block.name ?? "") && typeof args.nodeId === "string") set("nodeId", to(args.nodeId));
	if (block.name === "plan_init") {
		if (typeof args.mermaid === "string") set("mermaid", rewriteMermaidIds(args.mermaid, map));
		if (Array.isArray(args.concepts)) {
			const concepts = (args.concepts as Array<Record<string, unknown>>).map((c) => (typeof c?.id === "string" && map.has(c.id) ? { ...c, id: map.get(c.id) } : c));
			if (concepts.some((c, i) => c !== (args.concepts as unknown[])[i])) set("concepts", concepts);
		}
	}
	if (block.name === "pick_items" && Array.isArray(args.itemIds)) {
		const ids = (args.itemIds as unknown[]).map(to);
		if (ids.some((id, i) => id !== (args.itemIds as unknown[])[i])) set("itemIds", ids);
	}
	if (block.name === "set_goals" && Array.isArray(args.goals)) {
		const goals = (args.goals as Array<Record<string, unknown>>).map((g) => Array.isArray(g?.nodeIds) ? { ...g, nodeIds: [...new Set((g.nodeIds as unknown[]).map(to))] } : g);
		if (JSON.stringify(goals) !== JSON.stringify(args.goals)) set("goals", goals);
	}
	return next;
}

export interface ChatRewrite<M> {
	messages: M[];
	tree?: PlanTree;
	goals?: Array<{ nodeIds: string[] } & Record<string, unknown>>;
	changed: boolean;
}

/** Rewrite one chat's node ids. `goals` is the sitting's stored goal list (settings.timebox.goals). */
export function rewriteChat<M>(chat: { messages: readonly M[]; tree?: PlanTree; goals?: ReadonlyArray<{ nodeIds: string[] } & Record<string, unknown>> }, map: ReadonlyMap<string, string>): ChatRewrite<M> {
	if (map.size === 0) return { messages: [...chat.messages], ...(chat.tree ? { tree: chat.tree } : {}), changed: false };
	let changed = false;
	const messages = (chat.messages as readonly Message[]).map((raw) => {
		if (raw?.role === "assistant" && Array.isArray(raw.content)) {
			let content: Block[] | null = null;
			(raw.content as Block[]).forEach((block, i) => {
				if (block?.type !== "toolCall") return;
				const args = rewriteArgs(block, map);
				if (!args) return;
				content ??= [...(raw.content as Block[])];
				content[i] = { ...block, arguments: args };
			});
			if (content) { changed = true; return { ...raw, content }; }
			return raw;
		}
		if (raw?.role === "toolResult" && (raw.toolName === "plan_init" || raw.toolName === "pick_items")) {
			const details = raw.details as { tree?: PlanTree } | undefined;
			if (details?.tree?.nodes) {
				const tree = rewriteTree(details.tree, map);
				if (JSON.stringify(tree) !== JSON.stringify(details.tree)) { changed = true; return { ...raw, details: { ...details, tree } }; }
			}
		}
		return raw;
	}) as M[];
	let tree = chat.tree;
	if (tree) {
		const next = rewriteTree(tree, map);
		if (JSON.stringify(next) !== JSON.stringify(tree)) { changed = true; tree = next; }
	}
	let goals = chat.goals ? [...chat.goals] : undefined;
	if (goals) {
		const next = goals.map((g) => ({ ...g, nodeIds: [...new Set(g.nodeIds.map((id) => map.get(id) ?? id))] }));
		if (JSON.stringify(next) !== JSON.stringify(goals)) { changed = true; goals = next; }
	}
	return { messages, ...(tree ? { tree } : {}), ...(goals ? { goals } : {}), changed };
}

/** Every node id a chat names (tree + tool-call arguments), for finding what a merge touches. */
export function nodeIdsOfChat(chat: { messages: readonly unknown[]; tree?: PlanTree }): Set<string> {
	const ids = new Set<string>(chat.tree?.nodes.map((n) => n.id) ?? []);
	for (const raw of chat.messages as Message[]) {
		if (raw?.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const block of raw.content as Block[]) {
			const id = block?.type === "toolCall" ? block.arguments?.nodeId : undefined;
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}
