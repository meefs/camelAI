import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { AppShell, RouteError } from "./components/app-shell";
import {
	RunsListPage,
	RunsListSkeleton,
	runsLoader,
} from "./routes/runs-list";
import { RunDetailPage, runLoader } from "./routes/run-detail";

const legacyRun = location.hash.match(/^#\/run\/(.+)$/);
if (legacyRun) {
	history.replaceState(
		null,
		"",
		`/runs/${encodeURIComponent(decodeURIComponent(legacyRun[1]))}`,
	);
}

const router = createBrowserRouter([
	{
		path: "/",
		Component: AppShell,
		ErrorBoundary: RouteError,
		children: [
			{
				index: true,
				Component: RunsListPage,
				loader: runsLoader,
				HydrateFallback: RunsListSkeleton,
			},
			{ path: "runs/:runId", Component: RunDetailPage, loader: runLoader },
		],
	},
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
	<StrictMode>
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			disableTransitionOnChange
		>
			<RouterProvider router={router} />
		</ThemeProvider>
	</StrictMode>,
);
