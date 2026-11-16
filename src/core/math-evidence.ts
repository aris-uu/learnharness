/**
 * Math mode's evidence model. Competence is a vector, not one "held" flag:
 * recall (K), rationale (U), procedure (S) and proof (P) are credited
 * separately, and only from answers the learner produced. The per-chat gate is
 * derived from the record; a copy of each entry also goes to the global
 * evidence ledger (below) so later sessions can search it.
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

// ─── the global evidence ledger ──────────────────────────────────────────────
//
// Evidence lives in each chat's record (the record_evidence calls above, which
// the per-chat gate reads) AND, copied, in one global ledger so a later
// session can find it. Plan node ids are per-chat slugs, so the ledger carries
// the node's title and summary as recorded: cross-chat search matches on text.

export const SEARCH_EVIDENCE_TOOL = "search_evidence";
export const EVIDENCE_SEARCH_LIMIT = 20;

/** One ledger line: a successful record_evidence call, with its chat and node text. */
export interface EvidenceRecord extends MathEvidence {
	chatId: string;
	nodeTitle: string;
	nodeSummary?: string;
	/** ISO time the evidence was recorded. */
	recordedAt: string;
}

/** The global ledger port (src/store/evidence.ts is the fs adapter). */
export interface EvidenceStore {
	/** True once the ledger file exists, even empty: backfill has run. */
	exists(): boolean;
	/** Every record, oldest first; a repeated id keeps its first line. */
	list(): EvidenceRecord[];
	append(record: EvidenceRecord): void;
	/** Replace the whole ledger (backfill). */
	replaceAll(records: readonly EvidenceRecord[]): void;
	/** Drop one chat's records; returns how many were removed. */
	removeChat(chatId: string): number;
}

/** A record for the ledger, with the node's text taken from the plan at hand. */
export function evidenceRecord(
	chatId: string,
	entry: MathEvidence,
	tree: PlanTree | undefined,
	recordedAt: string,
): EvidenceRecord {
	const node = tree?.nodes.find((candidate) => candidate.id === entry.nodeId);
	return {
		...entry,
		chatId,
		nodeTitle: node?.title ?? entry.nodeId,
		...(node?.summary ? { nodeSummary: node.summary } : {}),
		recordedAt,
	};
}

/** A chat's successful evidence as ledger records, timed by the calling message. */
export function evidenceRecordsFromChat(chat: {
	id: string;
	messages: readonly unknown[];
	tree?: PlanTree;
	updatedAt?: string;
}): EvidenceRecord[] {
	const times = new Map<string, string>();
	for (const raw of chat.messages as Array<RecordMessage & { timestamp?: unknown }>) {
		const time = typeof raw?.timestamp === "number" ? new Date(raw.timestamp).toISOString() : undefined;
		for (const call of toolCalls(raw)) if (time) times.set(String(call.id), time);
	}
	const fallback = chat.updatedAt ?? new Date(0).toISOString();
	return evidenceFromMessages(chat.messages).map((entry) =>
		evidenceRecord(chat.id, entry, chat.tree, times.get(entry.id) ?? fallback));
}

/**
 * One-time seed of the ledger from every chat's successful record_evidence
 * calls. Runs only while the ledger does not exist yet, and writes it even
 * when empty, so it never runs twice. Returns the count, or null when skipped.
 */
export function backfillEvidence(
	chatStore: {
		listChats(): readonly { id: string }[];
		getChat(id: string): { id: string; messages: readonly unknown[]; tree?: PlanTree; updatedAt?: string } | null;
	},
	evidenceStore: EvidenceStore,
): number | null {
	if (evidenceStore.exists()) return null;
	const records: EvidenceRecord[] = [];
	for (const summary of chatStore.listChats()) {
		const chat = chatStore.getChat(summary.id);
		if (chat) records.push(...evidenceRecordsFromChat(chat));
	}
	records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
	evidenceStore.replaceAll(records);
	return records.length;
}

function searchTerms(query: string): string[] {
	const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
	return [...new Set(terms)];
}

export interface EvidenceSearchHit {
	record: EvidenceRecord;
	/** How many distinct query terms matched. */
	score: number;
	/** The node's status in its own chat, from that chat's ledger records. */
	nodeStatus: MathNodeStatus;
}

/**
 * Case-insensitive keyword search over node title, summary and note. Ranked
 * by distinct terms matched, then newest first; the current chat is left out.
 * Returns null when the query holds no searchable term.
 */
export function searchEvidence(
	records: readonly EvidenceRecord[],
	query: string,
	excludeChatId: string,
	limit = EVIDENCE_SEARCH_LIMIT,
): EvidenceSearchHit[] | null {
	const terms = searchTerms(query);
	if (terms.length === 0) return null;
	const byChat = new Map<string, EvidenceRecord[]>();
	for (const record of records) {
		if (record.chatId === excludeChatId) continue;
		const list = byChat.get(record.chatId) ?? [];
		list.push(record);
		byChat.set(record.chatId, list);
	}
	const hits: EvidenceSearchHit[] = [];
	for (const [, chatRecords] of byChat) {
		for (const record of chatRecords) {
			const text = `${record.nodeTitle}\n${record.nodeSummary ?? ""}\n${record.note}`.toLowerCase();
			const score = terms.filter((term) => text.includes(term)).length;
			if (score > 0) hits.push({ record, score, nodeStatus: nodeStatus(record.nodeId, chatRecords) });
		}
	}
	hits.sort((a, b) => b.score - a.score || b.record.recordedAt.localeCompare(a.record.recordedAt));
	return hits.slice(0, limit);
}

/** The learner's go-back request, as ordinary lesson text the tutor acts on. */
export function goBackMessage(node: { id: string; title: string }): string {
	return `I want to go back to the prerequisite "${node.title}" (node ${node.id}). I don't have it solid enough to continue.`;
}
