---
name: data-analysis
description: Analyze data using Python and SQL tools. Use when the user asks to process CSVs, Excel, Parquet, PDFs, Word docs, or PowerPoint files, query databases (PostgreSQL, MySQL, SQLite, SQL Server, BigQuery), create charts or visualizations, or perform any data analysis. For live dashboards or data apps, read the developing-software skill.
license: Complete terms in LICENSE.txt
---

# Data Analysis

## Python Environment (DO-backed projects)

For DO-backed projects, data analysis runs in a stateless per-workspace sandbox
over the project filesystem — there is no persistent VM to set up. **The default
data stack is preinstalled**, so most analysis needs no environment step at all:

> pandas, numpy, polars, duckdb, pyarrow, altair, plotly, matplotlib, seaborn,
> scipy, scikit-learn, statsmodels, openpyxl, xlsxwriter, pdfplumber, python-docx,
> python-pptx, sqlalchemy (+ psycopg/pymysql), jupyter/nbconvert.

- **Need a package beyond the stack?** `add_python_dependency({ project, packages: ["<pkg>"] })`
  — it runs `uv add` and persists `pyproject.toml` + `uv.lock` back to the project.
  (You can also just edit `pyproject.toml`; the next run's `uv sync` reconciles it.)
- **Run a notebook:** `run_notebook` (see below) — execution + validation in one call.
- **Ad-hoc shell/Python:** `analysis_exec({ command, project? })`.

`.venv` is derived state — it is reconstituted in the sandbox from `pyproject.toml` +
`uv.lock` and is never stored. Do not `uv init` / `uv add` by hand.

### Data placement

- **Big inputs are mounted read-only, not copied** — read them in place
  (`pd.read_csv(...)`, `duckdb.read_parquet(...)`), never copy them into the project:
  - **Uploaded files** are at `/uploads/<name>` — the same `uploads/<name>` R2
    reference you use elsewhere, with a leading slash.
  - **Connection exports** are at `'/' + r2_key` (see the DuckDB section below).
- **Large intermediates go in `$SCRATCH`** — a per-run directory the sandbox
  creates for you (read it via `os.environ["SCRATCH"]`); it is removed after the
  run and never persisted.
- **Notebooks and small results go in the project** — those persist back to the
  project filesystem after each run (files over ~25 MB are reported, not auto-saved;
  `move` the ones you want to keep to R2 outputs).

## Database CLI

### usql - Universal SQL CLI

```bash
# PostgreSQL
usql postgres://user:pass@host:5432/dbname

# MySQL
usql mysql://user:pass@host:3306/dbname

# SQLite
usql sqlite:./data.db

# SQL Server
usql sqlserver://user:pass@host/instance/dbname

# BigQuery — use Python client with access token instead (see BigQuery section below)
# usql bigquery:// is NOT recommended; use the google-cloud-bigquery Python client
```

Common commands inside usql:
- `\dt` - List tables
- `\d tablename` - Describe table
- `\q` - Quit

### sqlite3

```bash
sqlite3 data.db "SELECT * FROM users LIMIT 10"
```

## Python Data Processing

### Core Libraries

| Package | Purpose | Status |
|---------|---------|--------|
| `pandas` | DataFrames and data manipulation | preinstalled |
| `numpy` | Numerical computing | preinstalled |
| `polars` | Fast DataFrame library (Rust-based) | preinstalled |
| `duckdb` | In-process SQL analytics | preinstalled |

```python
import pandas as pd
import polars as pl
import duckdb

# Pandas
df = pd.read_csv("data.csv")
df.groupby("category").sum()

# Polars (faster for large data)
df = pl.read_csv("data.csv")
df.group_by("category").agg(pl.sum("amount"))

# DuckDB - SQL on files directly
result = duckdb.sql("SELECT * FROM 'data.csv' WHERE amount > 1000")
print(result.df())
```

### Visualization

camelAI's notebook preview renders Altair and Plotly charts natively — not in iframes. Chart colors, text, and backgrounds automatically adapt to the user's light/dark theme.

**Preferred order:**
1. **Altair** (Vega-Lite) — emits structured specs with full theme support
2. **Plotly** — also renders natively; use when Altair doesn't cover the chart type (3D, maps, financial)
3. **matplotlib / seaborn** — static PNG fallback; won't adapt to dark mode

| Package | Purpose | Status |
|---------|---------|--------|
| `altair` | Declarative charts (Vega-Lite) — **preferred** | preinstalled |
| `plotly` | Interactive charts — use for 3D, maps, finance | preinstalled |
| `matplotlib` | Static plots (fallback) | preinstalled |
| `seaborn` | Statistical visualization (fallback) | preinstalled |

```python
# Altair (preferred — renders natively with dark/light theme support)
import altair as alt

chart = alt.Chart(df).mark_bar().encode(
    x="category:N",
    y="amount:Q"
).properties(
    title=alt.Title("Sales by Category", subtitle="Q4 2025 data"),
    width=500,
    height=300
)
chart  # Display in notebook cell output

# Plotly (native rendering, use for charts Altair doesn't support)
import plotly.express as px
fig = px.line(df, x="date", y="value", title="Trend Over Time")
fig.show()

# Matplotlib/Seaborn (static PNG — no dark mode support)
import matplotlib.pyplot as plt
import seaborn as sns
sns.barplot(data=df, x="category", y="amount")
plt.savefig("barplot.png")
```

**Altair renderer constraints:**
- Use `alt.Title("Title", subtitle="Subtitle")` — both are themed automatically
- Do **not** set `background` — the renderer makes backgrounds transparent
- Do **not** hardcode text colors — the renderer applies theme-appropriate colors
- Set `width`/`height` via `.properties()` — width is overridden to fill the container; height is used as a baseline
- Arc marks (donut/pie) are detected and allocated extra vertical space automatically

**Plotly renderer constraints:**
- Use `fig.show()` to emit Plotly MIME output — the renderer picks it up natively
- Do **not** use `fig.write_image()` or `fig.write_html()` — these bypass native rendering
- Do **not** set `paper_bgcolor` or `plot_bgcolor` — the renderer makes them transparent
- Subtitles via `layout.annotations` are automatically themed

### Tabular output

When outputting tabular data in notebooks, use plain pandas DataFrames — not `df.style` (pandas Styler). The rendering environment handles table styling automatically with theme-aware colors, index columns, and overflow handling.

**Never output tables as raw HTML** (e.g., manually constructing `<table>` tags or using `IPython.display.HTML("<table>...")`). Always use pandas DataFrames for tabular output — the rendering environment detects DataFrames automatically and applies theme-aware styling, sortable columns, row filtering, and CSV export. Raw HTML tables bypass all of this and render unstyled in an iframe.

Set pandas display options explicitly only when the user asks for different table display limits.

Only use `df.style` when the user explicitly requests conditional formatting, cell-level color coding, or other per-cell visual logic that can't be achieved with a plain table.

## Jupyter Notebook Workflow (Preferred)

For exploratory analysis, deliver results as a Jupyter notebook (`.ipynb`).

**Do not** deliver results as a:
- standalone `.py` script with separate chart/image files 
- html file
unless explicitly requested by the user. 

Notebooks preview reliabily with rich Altair charts and markdown rendering, and are better for report consumption. They combine code, visual output, and markdown conclusions in one artifact. 

### Build notebooks incrementally

- Keep a narrative flow:
  - markdown cell: objective and dataset context
  - code cell: data loading/cleaning
  - markdown cell: what to look for
  - code cell: chart/query
  - markdown cell: interpretation and takeaway

### Execute notebooks

Run the notebook with **`run_notebook`** — it executes (`jupyter nbconvert
--execute --inplace`), validates the result, and persists the executed notebook +
any changed files back to the project, all in one call:

```text
run_notebook({ project: "<project>", path: "analysis.ipynb" })
```

It returns `{ ok, executed, validation: { clean, issues }, stdout, stderr,
changedFiles, ... }`. The validator catches errors `nbconvert` doesn't surface
(cell exceptions, charts that fell back to text/plain, blank charts with constant
data). **If `ok` is false, fix the failing cells (see `validation.issues` /
`stderr`) and re-run.** Never suppress errors — do not reach for `--allow-errors`,
which silently embeds tracebacks the user sees in the rendered report.

Setup calls whose return value is not meaningful report content, such as
`alt.data_transformers.disable_max_rows()` or `plt.plot(...)`, should be silenced
with a trailing `;` or assigned to `_` so object reprs do not leak into outputs.

### Preview notebooks in chat

After `run_notebook` returns `ok`, set the active chat preview to the executed
notebook (it now lives in the project filesystem):

```text
set_preview(
  path="analysis.ipynb",
  location="project",
  project="<project>",
  content_type="application/x-ipynb+json"
)
```

### Publish files as standalone apps

When a user wants to publish a notebook (or any file) as a standalone app, deploy with:

```bash
publish my-notebook-app --file /path/to/analysis.ipynb
```

This deploys a lightweight Cloudflare Worker that serves the file via the main app's embed viewer. No build step required.

### How notebooks are presented

camelAI renders notebooks in **Report mode** by default — the user sees a polished article, not raw cells.

**What Report mode does:**
- Hides all code — only markdown prose and cell outputs (charts, tables, text) are visible
- Auto-hides setup cells (imports, data loading, `.describe()`, `pd.set_option`, etc.)
- Extracts the first `#` heading as the report title and the following paragraph as the subtitle
- Builds a sidebar table of contents from `##` and `###` headings

**Structure notebooks for Report mode:**
- Start with a single `#` heading followed by a one-sentence description (becomes the report header)
- Use `##` headings to define sections — these populate the sidebar TOC
- Keep setup code in dedicated cells (the classifier hides entire cells, not individual lines)
- Write markdown between analysis cells explaining what each result shows
- End with a `## Key Findings` or `## Conclusion` section

The user can toggle to Notebook mode to see all cells, code, and execution counts, but Report mode is the default first impression.

## Scientific Computing & ML

| Package | Purpose | Status |
|---------|---------|--------|
| `scipy` | Scientific computing, optimization | preinstalled |
| `scikit-learn` | Machine learning algorithms | preinstalled |

```python
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
model = LinearRegression().fit(X_train, y_train)
predictions = model.predict(X_test)
```

## Large or Cross-Source Data (DuckDB over R2 exports)

For **heavy** database work — bulk extracts, cross-source joins (e.g. Dynamics ⋈
BigQuery), or aggregations over more rows than fit comfortably in a notebook — don't
pull rows into pandas. Export each source to R2 and reduce it with DuckDB via
**`run_code`**. This runs in the same analysis sandbox as your notebooks, so a
reduced result can be charted right after — no separate tier.

Three steps, all driven from a single `js_exec` block:

1. **Export** a connection's full query result to R2. A connection's `export`
   method streams the whole result set server-side (no row cap, credentials stay
   server-side) and returns `{ ok, r2_key }`. Exportable connections: the SQL
   family, ClickHouse, and BigQuery — check with
   `tools.analysis_list_connections()`, which reports each one's `exportFormat`.

   > **Export format depends on the source — read it with the matching DuckDB
   > reader.** SQL databases (Postgres, MySQL, Neon, PlanetScale) and ClickHouse
   > export **Parquet** → `read_parquet`. **BigQuery exports NDJSON, not Parquet**
   > (its REST API only returns JSON, so there's no Parquet to stream) →
   > `read_json_auto`. Calling `read_parquet` on a BigQuery `.ndjson` export
   > fails. The `r2_key` extension (`.parquet` vs `.ndjson`) and the
   > `exportFormat` field both tell you which reader to use.

2. **Run DuckDB** over the staged exports with `tools.run_code({ code, params })`.
   `duckdb`, `pandas`, `pyarrow`, and `numpy` are preinstalled. Each export is
   mounted read-only at `/<r2_key>`, so read it with the reader for its format:
   `duckdb.read_parquet('/' + r2_key)` for SQL/ClickHouse Parquet,
   `duckdb.read_json_auto('/' + r2_key)` for BigQuery NDJSON. Pass values through
   **`params`** (a JSON dict) rather than interpolating them into the code string —
   they arrive as a Python `params` dict. It returns `{ ok, stdout, stderr, error }`;
   whatever you `print()` is in `stdout` (a plain string). Print CSV/JSON to hand
   structured data back to `js_exec`. Always check `ok` — on a failed read it's
   `false` with the message in `error`. Prefer `duckdb.sql(...)` (a fresh connection
   per call) over a long-lived module-level `con`: a single failed read aborts a
   reused connection's transaction, so every later statement then fails with a
   `TransactionException`.

3. **Use the result** in `js_exec` — write it to a file with
   `tools.write({ location, path, content })` (`location`: `"workspace"` for durable
   workspace files, `"r2"` for user-visible outputs), feed it onward, or load it
   into a notebook to chart.

```javascript
// js_exec — export → DuckDB → save to a workspace file, end to end.
const entry = await env.CONNECTIONS.find("ClickHouse");
const { r2_key } = await env.CONNECTIONS[entry.alias].export({
  query: "SELECT database, name, engine FROM system.tables WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')",
});

const result = await tools.run_code({
  params: { r2_key },
  code: `
import duckdb
df = duckdb.sql("SELECT * FROM read_parquet('/' || ?)", params=[params["r2_key"]]).df()
print(df.to_csv(index=False))
`,
});
const csv = result.stdout; // flat string — no result.logs.stdout[0] digging

await tools.write({ location: "workspace", path: "clickhouse_tables.csv", content: csv });
return { rows: csv.trim().split("\n").length - 1, saved: "clickhouse_tables.csv" };
```

Cross-source joins work the same way — export each source, pass both keys via
`params`, then `JOIN` the mounted files in one `run_code` call:

```python
# inside run_code, params = { "freight_key": ..., "rates_key": ... }
# freight_key came from a SQL/ClickHouse export (Parquet) → read_parquet;
# rates_key came from a BigQuery export (NDJSON) → read_json_auto.
import duckdb
duckdb.sql(
  "SELECT f.shipment_id, f.charge, r.expected_rate, f.charge - r.expected_rate AS delta "
  "FROM read_parquet('/' || ?) f "
  "JOIN read_json_auto('/' || ?) r USING (shipment_id) "
  "WHERE f.charge <> r.expected_rate",
  params=[params["freight_key"], params["rates_key"]],
).df()
```

**When to use which:**
- **`run_code`** — large/bulk extracts, cross-source joins, heavy aggregation over
  R2 exports. Use it to *reduce* big data down to a small result via DuckDB.
- **`run_notebook`** — interactive exploration, visualization, and the final report.
  Charts (Altair/Plotly) render from notebook outputs.

Typical flow for big data: export → reduce/join in `run_code` → load the small
aggregated result into a notebook to chart and narrate.

For long-running exports followed by analysis, the `deterministic-automations`
skill can orchestrate the export and the DuckDB step as workflow steps.

## Database Connectivity

| Package | Purpose | Status |
|---------|---------|--------|
| `sqlalchemy` | Python ORM and database toolkit | preinstalled |
| `psycopg` | PostgreSQL driver | preinstalled |
| `pymysql` | MySQL driver | preinstalled |
| `google-cloud-bigquery` | BigQuery client | add with `add_python_dependency` |
| `google-cloud-bigquery-storage` | BigQuery Storage API client for faster downloads | add with `add_python_dependency` |
| `google-auth` | Google authentication (used for BigQuery tokens) | add with `add_python_dependency` |

### SQL Server / PostgreSQL / MySQL (Primary: Worker `DATA_PROXY` service binding)

For deployed/user-uploaded Cloudflare Workers, use the `DATA_PROXY` service binding first.
This is the most important path because Workers may not be able to use native DB drivers/TCP connectivity directly.

Read example:

```typescript
const readResult = await context.cloudflare.env.DATA_PROXY.postgresQuery({
  mode: "read",
  host: "db.example.com",
  user: "user",
  password: "pass",
  database: "analytics",
  query: "SELECT id, email FROM users WHERE id = $1 LIMIT 100",
  params: [123],
});

if (!readResult.ok) throw new Error(readResult.error.message);
const rows = readResult.data.recordset ?? [];
```

Modify example:

```typescript
const modifyResult = await context.cloudflare.env.DATA_PROXY.postgresQuery({
  mode: "modify",
  host: "db.example.com",
  user: "user",
  password: "pass",
  database: "analytics",
  query: "UPDATE users SET last_seen_at = NOW() WHERE id = $1",
  params: [123],
});

if (!modifyResult.ok) throw new Error(modifyResult.error.message);
const affected = modifyResult.data.rowsAffected?.[0] ?? 0;
```

Supported query methods:
- `DATA_PROXY.mssqlQuery(...)` (named params, e.g. `@id`)
- `DATA_PROXY.postgresQuery(...)` (positional params array)
- `DATA_PROXY.mysqlQuery(...)` (positional params array)
- All query calls require `mode: "read"` or `mode: "modify"` (no auto-detection).

### Workspace connections from notebooks (preferred)

The analysis sandbox exposes workspace connections through the stateless RPC endpoint in `CAMELAI_CONNECTIONS_RPC_URL`. Use this from notebooks and Python scripts instead of asking for credentials or looking for connection env vars. The sandbox receives only the proxy URL; camelAI applies workspace identity and stored auth outside it.

This `query`-into-pandas pattern is for **interactive, reasonably-sized** result sets. For bulk extracts or cross-source joins, use the `export` + `run_code` path above instead of pulling every row into the notebook.

Connection query methods run your SQL **exactly as written** — nothing (no `LIMIT`, no `FORMAT`) is appended. Add your own `LIMIT` when you want to cap inline rows, and don't add a ClickHouse `FORMAT` clause (the broker handles output format). Reach for `export` whenever you want the full, uncapped result.

Minimal Python helper:

```python
import json
import os
import urllib.error
import urllib.request

CONNECTIONS_URL = os.environ["CAMELAI_CONNECTIONS_RPC_URL"]

def connection_rpc(action, **params):
    payload = {"action": action, **params}
    request = urllib.request.Request(
        CONNECTIONS_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            raise RuntimeError(f"connections RPC HTTP {error.code}: {text}") from error
    if not body.get("ok", False):
        raise RuntimeError(body.get("error", body))
    return body["result"]

entry = connection_rpc("find", query="postgres")
result = connection_rpc(
    "invoke",
    connection=entry["connection"]["id"],
    method="query",
    input={"query": "SELECT 1 AS ok"},
)
```

For dataframe workflows:

```python
import pandas as pd

def connection_rows(result):
    for candidate in (
        result.get("data"),
        result.get("data", {}).get("rows") if isinstance(result.get("data"), dict) else None,
        result.get("rows"),
        result.get("recordset"),
    ):
        if isinstance(candidate, list):
            return candidate
    for item in result.get("content", []):
        if item.get("type") != "text":
            continue
        try:
            parsed = json.loads(item.get("text", ""))
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            for candidate in (
                parsed.get("data"),
                parsed.get("data", {}).get("rows") if isinstance(parsed.get("data"), dict) else None,
                parsed.get("rows"),
                parsed.get("recordset"),
            ):
                if isinstance(candidate, list):
                    return candidate
    return []

entry = connection_rpc("find", query="clickhouse")
result = connection_rpc(
    "invoke",
    connection=entry["connection"]["id"],
    method="query",
    input={"query": "SELECT * FROM events LIMIT 1000"},
)

rows = connection_rows(result)
df = pd.DataFrame(rows)
df.head()
```

Discover available connections and schemas:

```python
catalog = connection_rpc("methods")
[(entry["alias"], entry["connection"]["type"], [m["name"] for m in entry["methods"]]) for entry in catalog]
```

### Direct drivers (explicit external credentials only)

Use native drivers only when the user explicitly provides direct connection details, asks for direct connectivity, or the data source is not a saved camelAI workspace connection.

```python
from sqlalchemy import create_engine
import pandas as pd

# PostgreSQL direct
pg_engine = create_engine("postgresql+psycopg://user:pass@host/db")
pg_df = pd.read_sql("SELECT * FROM users", pg_engine)

# MySQL direct
mysql_engine = create_engine("mysql+pymysql://user:pass@host/db")
mysql_df = pd.read_sql("SELECT * FROM orders", mysql_engine)
```

## File Formats

| Package | Purpose | Status |
|---------|---------|--------|
| `pyarrow` | Parquet, Arrow files | preinstalled |
| `openpyxl` | Excel (.xlsx) read/write | preinstalled |
| `xlsxwriter` | Excel creation with formatting | preinstalled |
| `pdfplumber` | PDF text and table extraction | preinstalled |
| `python-docx` | Word documents | preinstalled |
| `python-pptx` | PowerPoint files | preinstalled |

```python
# Read Excel
df = pd.read_excel("data.xlsx", sheet_name="Sheet1")

# Write Excel with formatting
df.to_excel("output.xlsx", index=False)

# Read Parquet
df = pd.read_parquet("data.parquet")

# Extract tables from PDF
import pdfplumber
with pdfplumber.open("report.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
```

## Live Dashboards & Data Apps

When the user wants a **live dashboard**, **data app**, or any interactive web UI built on top of their database or data sources, use the `developing-software` skill. That skill covers deploying fullstack Cloudflare Workers apps with React, Vite, and shadcn/ui — which is the right approach for persistent, shareable dashboards.

**Read the `developing-software` skill** before building any dashboard or data-driven web app. It documents:
- `create-worker` for scaffolding React + Vite projects
- Durable Objects with SQLite for server-side state
- shadcn/ui components for charts, tables, and UI
- Deployment via `bun deploy`

Database connection credentials are available through the virtual connections binding. Prefer connection methods over direct credential handling.

## Additional Packages

| Package | Purpose | Status |
|---------|---------|--------|
| `statsmodels` | Statistical modeling, time series | preinstalled |
| `xgboost` | Gradient boosting | add with `add_python_dependency` |
| `geopandas` | Geospatial data | add with `add_python_dependency` |
| `opencv-python-headless` | Computer vision | add with `add_python_dependency` |
