/**
 * Math mode's evidence model. Competence is a vector, not one "held" flag:
 * recall (K), rationale (U), procedure (S) and proof (P) are credited
 * separately, and only from answers the learner produced. The truth is the
 * global attempt log (core/math-concepts.ts, docs/global-concepts-plan.md);
 * this file holds the status rules over it, and the per-sitting reading of
 * a transcript the plan panel shows.
 */
import type { PlanTree } from "./contracts/plan.ts";

export const MATH_DIMENSIONS = ["K", "U", "S", "P"] as const;
export type MathDimension = (typeof MATH_DIMENSIONS)[number];

/** No `assumed` (2026-11-25): an earlier session's evidence counts directly on the global concept. */
export const MATH_OUTCOMES = ["correct", "correct_slow", "partial", "incorrect", "learner_override"] as const;
export type MathOutcome = (typeof MATH_OUTCOMES)[number];

export const RECORD_EVIDENCE_TOOL = "record_evidence";

/** Recurring proof/computation habits a grade can be tagged with (2026-11-18).
 *  Tags name WHY an attempt fell short, so the same failure can be counted
 *  across sessions instead of re-discovered. Doctrine: profiles/math/shared/25-habits.md. */
export const MATH_HABITS = [
	"unjustified_step",
	"unchecked_membership",
	"wrong_hypothesis",
	"backward_only",
	"dropped_term",
	"unverified_candidate",
	"incomplete_statement",
	"arithmetic_slip",
] as const;
export type MathHabit = (typeof MATH_HABITS)[number];

/** The valid, de-duplicated habit tags of a raw value; absent when none. */
export function habitsOf(value: unknown): MathHabit[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tags = [...new Set(value.filter((tag): tag is MathHabit => (MATH_HABITS as readonly unknown[]).includes(tag)))];
	return tags.length > 0 ? tags : undefined;
}

export interface MathEvidence {
	id: string;
	nodeId: string;
	dimension: MathDimension;
	outcome: MathOutcome;
	hints: number;
	note: string;
	/** Why the attempt fell short, when it did (absent on old records). */
	habits?: MathHabit[];
}

export type MathNodeStatus = "solid" | "skipped" | "in_progress" | "none";

export const MATH_STATUS_LABELS: Record<MathNodeStatus, string> = {
	solid: "solid",
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
			const habits = habitsOf(input.habits);
			out.push({
				id: String(call.id),
				nodeId: input.nodeId as string,
				dimension: input.dimension as MathDimension,
				outcome: input.outcome as MathOutcome,
				hints: typeof input.hints === "number" ? input.hints : 0,
				note: typeof input.note === "string" ? input.note : "",
				...(habits ? { habits } : {}),
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

/** Written questions whose answers can carry credit. */
const WRITTEN_QUESTION_TOOLS = new Set(["explain", "recall"]);

/**
 * The tool-call ids of written questions (explain or recall) the learner
 * actually answered in this record, tagged or not. A probe asks before the
 * plan exists, so its questions carry no nodeId; record_evidence may cite
 * one of these ids as `probeAnswer` to credit a node the probe tested
 * (owner, 2026-11-19: probe-proven prerequisites were landing as assumed,
 * which leaves them without a forgetting curve).
 */
export function answeredWrittenQuestions(messages: readonly unknown[]): Map<string, string> {
	const answered = new Set<string>();
	for (const raw of messages as RecordMessage[]) {
		if (raw?.role !== "toolResult" || !WRITTEN_QUESTION_TOOLS.has(raw.toolName as string) || raw.isError === true || !Array.isArray(raw.content)) continue;
		const text = (raw.content as Array<{ text?: unknown }>)[0]?.text;
		if (typeof text !== "string" || typeof raw.toolCallId !== "string") continue;
		try {
			const answer = JSON.parse(text) as { dontKnow?: unknown; dismissed?: unknown };
			if (answer.dontKnow !== true && answer.dismissed !== true) answered.add(raw.toolCallId);
		} catch { /* An unparseable result is not evidence of an attempt. */ }
	}
	// id → question text, oldest first. The model does not reliably see
	// tool-call ids, so rejections list these for it to copy (owner,
	// 2026-11-25: probe answers kept landing as assumed for want of the id).
	const questions = new Map<string, string>();
	for (const raw of messages as RecordMessage[]) {
		for (const call of toolCalls(raw)) {
			if (typeof call.id !== "string" || !answered.has(call.id)) continue;
			const question = (call.arguments as { question?: unknown } | undefined)?.question;
			questions.set(call.id, typeof question === "string" ? question : "");
		}
	}
	for (const id of answered) if (!questions.has(id)) questions.set(id, "");
	return questions;
}

/** The answered written questions as a list the model can copy an id from. */
export function describeWrittenQuestions(questions: ReadonlyMap<string, string>): string {
	if (questions.size === 0) return "This session has no answered written question.";
	const clip = (text: string) => {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
	};
	return "Answered written questions in this session (copy the id as probeAnswer):\n" +
		[...questions].map(([id, question]) => `- ${id}: ${clip(question) || "(no question text)"}`).join("\n");
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
	if (latest.outcome === "incorrect") return "in_progress";
	const credited = new Set(entries.filter(isCredited).map((entry) => entry.dimension));
	return credited.has("K") && (credited.has("U") || credited.has("S") || credited.has("P")) ? "solid" : "in_progress";
}

function passes(status: MathNodeStatus): boolean {
	return status === "solid" || status === "skipped";
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

/**
 * Direct prerequisites blocking a forward move. Staying put and moving back
 * never block. A prerequisite passes when this sitting's evidence makes it
 * solid (or the learner chose to move on), or when `establishedElsewhere`
 * says the global record holds it fresh (math tools: solid and recall at or
 * above the desired retention).
 */
export function blockingPrerequisites(
	tree: PlanTree,
	nodeId: string,
	current: string | null,
	evidence: readonly MathEvidence[],
	establishedElsewhere: (nodeId: string) => boolean = () => false,
): string[] {
	if (nodeId === current || (current !== null && prerequisiteChain(tree, current).includes(nodeId))) return [];
	return tree.edges
		.filter((edge) => edge.to === nodeId && !passes(nodeStatus(edge.from, evidence)) && !establishedElsewhere(edge.from))
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
	const recent = evidence.filter((entry) => entry.outcome !== "learner_override").slice(-PITCH_WINDOW);
	const credited = recent.filter(isCredited).length;
	const rate = recent.length === 0 ? null : credited / recent.length;
	return { graded: recent.length, credited, rate, stepDown: rate !== null && recent.length >= PITCH_MINIMUM && rate < MATH_PITCH_FLOOR };
}

export const SEARCH_EVIDENCE_TOOL = "search_evidence";
export const EVIDENCE_SEARCH_LIMIT = 20;

/** The learner's go-back request, as ordinary lesson text the tutor acts on. */
export function goBackMessage(node: { id: string; title: string }): string {
	return `I want to go back to the prerequisite "${node.title}" (node ${node.id}). I don't have it solid enough to continue.`;
}
