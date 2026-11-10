import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { derivePlanStatusesLh } from "../../core/contracts/plan.ts";
import {
	attemptedNodes,
	blockingPrerequisites,
	evidenceFromMessages,
	MATH_DIMENSIONS,
	MATH_OUTCOMES,
	mathPitch,
	nodeStatus,
	RECORD_EVIDENCE_TOOL,
	type MathEvidence,
} from "../../core/math-evidence.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult } from "../tool-execute.ts";
import type { PlanToolContext } from "./plan.ts";

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));

const recordEvidenceInput = Type.Object({
	nodeId: Type.String({ description: "The plan node this evidence is about. Must match a plan_init slug." }),
	dimension: literals(MATH_DIMENSIONS),
	outcome: literals(MATH_OUTCOMES),
	hints: Type.Integer({ minimum: 0, description: "How many hint rungs this answer needed. Zero when unaided." }),
	note: Type.String({ minLength: 1, description: "One line naming what was shown or what was missing." }),
});

type EvidenceInput = { nodeId: string; dimension: MathEvidence["dimension"]; outcome: MathEvidence["outcome"]; hints: number; note: string };

const CONCEAL_PROBLEM = "Math mode keeps the committed answer hidden so the attempt can continue: set conceal to true.";

/** Written answers only help if the answer stays hidden while the attempt runs. */
export function requireConcealedAnswer(tool: AgentTool<any>): AgentTool<any> {
	return {
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			if ((input as { conceal?: unknown }).conceal !== true) return invalidInputResult(tool.name, [CONCEAL_PROBLEM]);
			return tool.execute(toolCallId, input, ...rest);
		},
	};
}

/** The teacher's math tools. Evidence recorded during this run is kept here
 *  because the record may not hold it until the run settles. */
export function mathTeacherTools(ctx: Pick<PlanToolContext, "chatId" | "chatStore">) {
	const thisRun: MathEvidence[] = [];
	const readRecord = () => {
		const record = ctx.chatStore.getChat(ctx.chatId);
		const messages = (record?.messages ?? []) as LhMessage[];
		const persisted = evidenceFromMessages(messages);
		const known = new Set(persisted.map((entry) => entry.id));
		return { tree: record?.tree, messages, evidence: [...persisted, ...thisRun.filter((entry) => !known.has(entry.id))] };
	};

	const gateExplain = (tool: AgentTool<any>): AgentTool<any> => requireConcealedAnswer({
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			const { tree, messages, evidence } = readRecord();
			const nodeId = (input as { nodeId?: unknown }).nodeId;
			if (tree && typeof nodeId === "string" && tree.nodes.some((node) => node.id === nodeId)) {
				const current = derivePlanStatusesLh(tree, messages).current;
				const blocked = blockingPrerequisites(tree, nodeId, current, evidence);
				if (blocked.length > 0) {
					return invalidInputResult(tool.name, [
						`Mastery gate: prerequisite(s) ${blocked.join(", ")} of ${nodeId} are not established. ` +
						"Keep working there with a written attempt. If the probe directly supports one, record it as assumed; " +
						"record learner_override only if the learner explicitly asked to move on.",
					]);
				}
			}
			return tool.execute(toolCallId, input, ...rest);
		},
	});

	const recordEvidence: AgentTool<typeof recordEvidenceInput> = {
		name: RECORD_EVIDENCE_TOOL,
		label: RECORD_EVIDENCE_TOOL,
		description:
			"Record what the learner's latest written attempt demonstrated. Call it after judging an attempt, once per dimension shown. " +
			"K = stated the definition or theorem, U = explained why or what breaks, S = used it on a case, P = produced a proof or key step. " +
			"correct and correct_slow require a submitted written attempt on this node. " +
			"assumed = not tested, justified by direct probe evidence. learner_override = the learner explicitly chose to move on.",
		parameters: recordEvidenceInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const entry = input as EvidenceInput;
			const { tree, messages, evidence } = readRecord();
			if (!tree?.nodes.some((node) => node.id === entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`nodeId "${entry.nodeId}" matches no node in this session's plan map.`]);
			}
			if ((entry.outcome === "correct" || entry.outcome === "correct_slow") && !attemptedNodes(messages).has(entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`No submitted written attempt exists on ${entry.nodeId}, so it cannot earn credit.`]);
			}
			const saved: MathEvidence = { ...entry, id: toolCallId };
			thisRun.push(saved);
			const all = [...evidence, saved];
			const pitch = mathPitch(all);
			const result = {
				ok: true,
				nodeStatus: nodeStatus(entry.nodeId, all),
				recentCredited: `${pitch.credited}/${pitch.graded}`,
				instruction: pitch.stepDown
					? "Recent success is below the target band. Do not raise difficulty: step down to the weakest prerequisite with a smaller written problem."
					: "Stay near 80% success: one new idea at a time.",
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};

	return { gateExplain, recordEvidence };
}
