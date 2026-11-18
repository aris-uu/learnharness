import { MemoryTable } from "@/components/memory-view";
import { StartReviewButton } from "@/components/start-review";
import { readMemoryView } from "@/src/server";

export const dynamic = "force-dynamic";

/** The memory view: math-mode nodes and their forgetting curves (read only). */
export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
	const { show } = await searchParams;
	const view = readMemoryView();
	return (
		<div className="h-full overflow-y-auto">
			<MemoryTable view={view} filter={show === "all" ? "all" : "due"} action={<StartReviewButton due={view.items.filter((item) => item.due).length} />} />
		</div>
	);
}
