/**
 * /api/memory
 *   GET            — the due badge's poll: how many concepts are due now,
 *                    split mature (review) / learning + relearning (consolidation).
 *   GET ?ids=a,b   — recall now per concept id, for tinting plan maps (R1).
 *   POST           — the Memory page's controls (docs/global-concepts-plan.md §4 R4):
 *                    { action: "retire" | "unretire", id }
 *                    { action: "merge", id, into }      (rewrites every reference; no alias)
 *                    { action: "options", implicitCredit }
 */
import { conceptRecall, ConceptError, memoryDueSplit, mergeConcepts, saveMathOptions, setConceptRetired } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_IDS = 200;

export async function GET(req: Request) {
	const ids = new URL(req.url).searchParams.get("ids");
	if (ids !== null) {
		const list = ids.split(",").map((id) => id.trim()).filter(Boolean).slice(0, MAX_IDS);
		return Response.json({ recall: conceptRecall(list) });
	}
	return Response.json(memoryDueSplit());
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { action?: unknown; id?: unknown; into?: unknown; implicitCredit?: unknown } | null;
	try {
		if (body?.action === "options") {
			if (typeof body.implicitCredit !== "boolean") return Response.json({ error: "implicitCredit must be true or false" }, { status: 400 });
			return Response.json({ options: saveMathOptions({ implicitCredit: body.implicitCredit }) });
		}
		if (typeof body?.id !== "string" || !body.id) return Response.json({ error: "id required" }, { status: 400 });
		if (body.action === "retire" || body.action === "unretire") {
			setConceptRetired(body.id, body.action === "retire");
			return Response.json({ ok: true });
		}
		if (body.action === "merge") {
			if (typeof body.into !== "string" || !body.into) return Response.json({ error: "into required" }, { status: 400 });
			return Response.json({ ok: true, ...mergeConcepts(body.id, body.into, { reason: "Memory page" }) });
		}
		return Response.json({ error: "unknown action" }, { status: 400 });
	} catch (error) {
		if (error instanceof ConceptError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}
