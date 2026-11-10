/**
 * Math mode's evidence model. Competence is a vector, not one "held" flag:
 * recall (K), rationale (U), procedure (S) and proof (P) are credited
 * separately, and only from answers the learner produced. Everything here is
 * derived from the record; nothing is stored beside it.
 */
import type { PlanTree } from "./contracts/plan.ts";

export const MATH_DIMENSIONS = ["K", "U", "S", "P"] as const;
export type MathDimension = (typeof MATH_DIMENSIONS)[number];

export const MATH_OUTCOMES = ["correct", "correct_slow", "partial", "incorrect", "assumed", "learner_override"] as const;
export type MathOutcome = (typeof MATH_OUTCOMES)[number];

export const RECORD_EVIDENCE_TOOL = "record_evidence";

export interface MathEvidence {
	id: string;
	nodeId: string;
	dimension: MathDimension;
	outcome: MathOutcome;
	hints: number;
	note: string;
}

export type MathNodeStatus = "solid" | "conditional" | "skipped" | "in_progress" | "none";

export const MATH_STATUS_LABELS: Record<MathNodeStatus, string> = {
	solid: "solid",
	conditional: "assumed",
	skipped: "skipped",
	in_progress: "in progress",
	none: "not started",
};

/** The target band's floor: below it the tutor must step down. */
export const MATH_PITCH_FLOOR = 0.7;
const PITCH_WINDOW = 8;
const PITCH_MINIMUM = 4;

type RecordMessage = { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };
type ToolCallBlock = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

function toolCalls(message: RecordMessage): ToolCallBlock[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return (message.content as ToolCallBlock[]).filter((block) => block?.type === "toolCall");
}

function isEvidence(value: Record<string, unknown>): boolean {
	return typeof value.nodeId === "string" &&
		(MATH_DIMENSIONS as readonly unknown[]).includes(value.dimension) &&
		(MATH_OUTCOMES as readonly unknown[]).includes(value.outcome);
}

/** Evidence from successful record_evidence calls, oldest first. */
export function evidenceFromMessages(messages: readonly unknown[]): MathEvidence[] {
	const failed = new Set<unknown>();
	const settled = new Set<unknown>();
	for (const raw of messages as RecordMessage[]) {
		if (raw?.role !== "toolResult") continue;
		settled.add(raw.toolCallId);
		if (raw.isError === true) failed.add(raw.toolCallId);
	}
	const out: MathEvidence[] = [];
	for (const raw of messages as RecordMessage[]) {
		for (const call of toolCalls(raw)) {
			if (call.name !== RECORD_EVIDENCE_TOOL || !settled.has(call.id) || failed.has(call.id)) continue;
			const input = (call.arguments ?? {}) as Record<string, unknown>;
			if (!isEvidence(input)) continue;
			out.push({
				id: String(call.id),
				nodeId: input.nodeId as string,
				dimension: input.dimension as MathDimension,
				outcome: input.outcome as MathOutcome,
				hints: typeof input.hints === "number" ? input.hints : 0,
				note: typeof input.note === "string" ? input.note : "",
			});
		}
	}
	return out;
}

/** Nodes with at least one written attempt the learner actually submitted. */
export function attemptedNodes(messages: readonly unknown[]): Set<string> {
	const attempted = new Set<string>();
	const answered = new Set<unknown>();
	for (const raw of messages as RecordMessage[]) {
		if (raw?.role !== "toolResult" || raw.toolName !== "explain" || raw.isError === true || !Array.isArray(raw.content)) continue;
		const text = (raw.content as Array<{ text?: unknown }>)[0]?.text;
		if (typeof text !== "string") continue;
		try {
			const answer = JSON.parse(text) as { dontKnow?: unknown; dismissed?: unknown };
			if (answer.dontKnow !== true && answer.dismissed !== true) answered.add(raw.toolCallId);
		} catch { /* An unparseable result is not evidence of an attempt. */ }
	}
	for (const raw of messages as RecordMessage[]) {
		for (const call of toolCalls(raw)) {
			const nodeId = (call.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (call.name === "explain" && answered.has(call.id) && typeof nodeId === "string") attempted.add(nodeId);
		}
	}
	return attempted;
}

function isCredited(entry: MathEvidence): boolean {
	return (entry.outcome === "correct" || entry.outcome === "correct_slow") && entry.hints <= 1;
}

/** Solid needs recall plus one deeper dimension; the latest miss reopens a node. */
export function nodeStatus(nodeId: string, evidence: readonly MathEvidence[]): MathNodeStatus {
	const entries = evidence.filter((entry) => entry.nodeId === nodeId);
	const latest = entries.at(-1);
	if (!latest) return "none";
	if (latest.outcome === "learner_override") return "skipped";
	if (latest.outcome === "assumed") return "conditional";
	if (latest.outcome === "incorrect") return "in_progress";
	const credited = new Set(entries.filter(isCredited).map((entry) => entry.dimension));
	return credited.has("K") && (credited.has("U") || credited.has("S") || credited.has("P")) ? "solid" : "in_progress";
}

function passes(status: MathNodeStatus): boolean {
	return status === "solid" || status === "conditional" || status === "skipped";
}

/** Every prerequisite of a node, nearest first, excluding the node itself. */
export function prerequisiteChain(tree: PlanTree, nodeId: string): string[] {
	const chain: string[] = [];
	const seen = new Set([nodeId]);
	let frontier = [nodeId];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const edge of tree.edges) {
				if (edge.to !== id || seen.has(edge.from)) continue;
				seen.add(edge.from);
				chain.push(edge.from);
				next.push(edge.from);
			}
		}
		frontier = next;
	}
	return chain;
}

/** Direct prerequisites blocking a forward move. Staying put and moving back never block. */
export function blockingPrerequisites(
	tree: PlanTree,
	nodeId: string,
	current: string | null,
	evidence: readonly MathEvidence[],
): string[] {
	if (nodeId === current || (current !== null && prerequisiteChain(tree, current).includes(nodeId))) return [];
	return tree.edges
		.filter((edge) => edge.to === nodeId && !passes(nodeStatus(edge.from, evidence)))
		.map((edge) => edge.from);
}

export interface MathPitch {
	graded: number;
	credited: number;
	rate: number | null;
	stepDown: boolean;
}

/** The rolling success rate over recent written attempts. */
export function mathPitch(evidence: readonly MathEvidence[]): MathPitch {
	const recent = evidence.filter((entry) => entry.outcome !== "assumed" && entry.outcome !== "learner_override").slice(-PITCH_WINDOW);
	const credited = recent.filter(isCredited).length;
	const rate = recent.length === 0 ? null : credited / recent.length;
	return { graded: recent.length, credited, rate, stepDown: rate !== null && recent.length >= PITCH_MINIMUM && rate < MATH_PITCH_FLOOR };
}

/** The learner's go-back request, as ordinary lesson text the tutor acts on. */
export function goBackMessage(node: { id: string; title: string }): string {
	return `I want to go back to the prerequisite "${node.title}" (node ${node.id}). I don't have it solid enough to continue.`;
}
