import { useEffect, useMemo, useState } from "react";
import { NotebookPreview, type NotebookFile } from "@/components/chat-file-preview/notebook-preview";

const NOTEBOOK_PATH = "/notebook.ipynb";

type ViewMode = "report" | "notebook";

function isNotebookFile(value: unknown): value is NotebookFile {
  return typeof value === "object" && value !== null;
}

export default function App() {
  const [notebook, setNotebook] = useState<NotebookFile | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("report");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDefaultNotebook() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(NOTEBOOK_PATH);
        if (!response.ok) {
          throw new Error(`Failed to load ${NOTEBOOK_PATH} (${response.status})`);
        }

        const payload: unknown = await response.json();
        if (!isNotebookFile(payload)) {
          throw new Error("Notebook payload is not valid JSON.");
        }

        if (!cancelled) {
          setNotebook(payload);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load notebook.";
          setError(message);
          setNotebook(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadDefaultNotebook();

    return () => {
      cancelled = true;
    };
  }, []);

  const totalCells = useMemo(() => notebook?.cells?.length ?? 0, [notebook]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-border bg-card/50 p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
            Static Worker Notebook Renderer
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Python Notebook Preview</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Renders a bundled notebook from <code>{NOTEBOOK_PATH}</code> using copied Chiridion notebook preview components.
          </p>
          <div className="mt-4 flex items-center gap-2 text-xs">
            <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-muted-foreground">
              {totalCells.toLocaleString()} cell{totalCells === 1 ? "" : "s"}
            </span>
            <div className="ml-auto inline-flex rounded-md border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => setViewMode("report")}
                className={
                  viewMode === "report"
                    ? "rounded px-2.5 py-1 font-medium text-foreground"
                    : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                Report
              </button>
              <button
                type="button"
                onClick={() => setViewMode("notebook")}
                className={
                  viewMode === "notebook"
                    ? "rounded px-2.5 py-1 font-medium text-foreground"
                    : "rounded px-2.5 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                Notebook
              </button>
            </div>
          </div>
        </header>

        <section className="overflow-hidden rounded-2xl border border-border bg-card/40">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading notebook...</div>
          ) : null}

          {error ? (
            <pre className="m-4 overflow-auto rounded-lg border border-red-200 bg-red-50 p-3 font-mono text-xs whitespace-pre-wrap text-red-700">
              {error}
            </pre>
          ) : null}

          {!isLoading && !error && notebook ? (
            <NotebookPreview notebook={notebook} layout="panel" viewMode={viewMode} />
          ) : null}
        </section>
      </div>
    </main>
  );
}
