import { Button } from "@/components/ui/button";
import { FullLogo } from "@/components/ui/logo";
import {
	ExternalLink,
	Moon,
	SearchX,
	Sun,
	TriangleAlert,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
	isRouteErrorResponse,
	Link,
	Outlet,
	useRevalidator,
	useRouteError,
} from "react-router";

export function AppShell() {
	const { resolvedTheme, setTheme } = useTheme();
	return (
		<div className="min-h-screen bg-background text-foreground">
			<header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
				<div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
					<Link to="/" className="flex items-center gap-3">
						<FullLogo className="h-5 w-auto" />
						<span className="text-sm font-medium text-muted-foreground">Evals</span>
					</Link>
					<div className="flex-1" />
					<Button variant="ghost" size="sm" asChild>
						<a href="/skill" target="_blank" rel="noopener">
							How to run an eval
							<ExternalLink />
						</a>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Toggle theme"
						onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
					>
						<Sun className="dark:hidden" />
						<Moon className="hidden dark:block" />
					</Button>
				</div>
			</header>
			<main className="mx-auto w-full max-w-6xl px-6 py-8">
				<Outlet />
			</main>
		</div>
	);
}

export function RouteError() {
	const error = useRouteError();
	const revalidator = useRevalidator();
	const is404 = isRouteErrorResponse(error) && error.status === 404;
	const message = isRouteErrorResponse(error)
		? error.data || error.statusText
		: error instanceof Error
			? error.message
			: "Unexpected error";
	const Icon = is404 ? SearchX : TriangleAlert;

	return (
		<div className="flex flex-col items-center gap-3 py-24 text-center">
			<Icon className="size-8 text-muted-foreground" />
			<p className="text-sm font-medium">
				{is404 ? "Run not found" : "Something went wrong"}
			</p>
			<p className="max-w-md text-sm text-muted-foreground">{String(message)}</p>
			{is404 ? (
				<Button variant="outline" size="sm" asChild>
					<Link to="/">All runs</Link>
				</Button>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => revalidator.revalidate()}
				>
					Try again
				</Button>
			)}
		</div>
	);
}
