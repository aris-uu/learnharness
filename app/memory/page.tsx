import { MemoryTable } from "@/components/memory-view";
import { readMemoryView } from "@/src/server";

export const dynamic = "force-dynamic";

/** The memory view: math-mode nodes and their forgetting curves (read only). */
export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
	const { show } = await searchParams;
	return (
		<div className="h-full overflow-y-auto">
			<MemoryTable view={readMemoryView()} filter={show === "all" ? "all" : "due"} />
		</div>
	);
}
