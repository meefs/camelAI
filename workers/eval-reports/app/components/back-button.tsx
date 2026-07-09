import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";

export function BackButton({ fallback }: { fallback: string }) {
	const navigate = useNavigate();
	function goBack() {
		const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
		if (idx > 0) navigate(-1);
		else navigate(fallback);
	}
	return (
		<Button variant="ghost" size="sm" className="-ml-2 mb-4" onClick={goBack}>
			<ArrowLeft />
			Back
		</Button>
	);
}
