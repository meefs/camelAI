---
name: data-analysis
description: Analyze data using Python and SQL tools. Use when the user asks to process CSVs, Excel, Parquet, PDFs, Word docs, or PowerPoint files, query databases (PostgreSQL, MySQL, SQLite, SQL Server, BigQuery), create charts or visualizations, or perform any data analysis. For live dashboards or data apps, read the developing-software skill.
license: Complete terms in LICENSE.txt
---

# Data Analysis

## Python Environment Setup

Common data analysis packages are **cached in the image** for instant installation. Initialize a Python project in the workspace if one doesn't exist:

```bash
uv init --python 3.13
uv add pandas numpy polars matplotlib altair plotly seaborn scipy scikit-learn duckdb pyarrow jupyterlab
```

Run scripts and tools with `uv run`:
```bash
uv run python script.py
uv run jupyter nbconvert --to notebook --execute --inplace notebook.ipynb
```

Add more packages with `uv add <package>`. The project's `pyproject.toml` and `.venv` persist across sessions. Skip `uv init` if `pyproject.toml` already exists.

`google-cloud-bigquery`, `google-cloud-bigquery-storage`, and `google-auth` are cached in the image for fast `uv add`, but they are not preinstalled in the shared base interpreter.

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
| `pandas` | DataFrames and data manipulation | cached |
| `numpy` | Numerical computing | cached |
| `polars` | Fast DataFrame library (Rust-based) | cached |
| `duckdb` | In-process SQL analytics | cached |

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
| `altair` | Declarative charts (Vega-Lite) — **preferred** | cached |
| `plotly` | Interactive charts — use for 3D, maps, finance | cached |
| `matplotlib` | Static plots (fallback) | cached |
| `seaborn` | Statistical visualization (fallback) | cached |

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

The sandbox pre-configures pandas to show up to 200 rows and 200 characters per cell in notebook HTML output. You do not need to add `pd.set_option` calls for display limits unless the user asks for different values.

Only use `df.style` when the user explicitly requests conditional formatting, cell-level color coding, or other per-cell visual logic that can't be achieved with a plain table.

## Jupyter Notebook Workflow (Preferred)

For exploratory analysis, prefer delivering results as a Jupyter notebook (`.ipynb`) instead of a standalone `.py` script with separate chart/image files. Notebooks combine code, visual output, and markdown conclusions in one artifact.

### Build notebooks incrementally

- Keep a narrative flow:
  - markdown cell: objective and dataset context
  - code cell: data loading/cleaning
  - markdown cell: what to look for
  - code cell: chart/query
  - markdown cell: interpretation and takeaway

### Execute notebooks

```bash
uv run jupyter nbconvert --to notebook --execute --inplace analysis.ipynb
```

**Always validate after execution.** Run the notebook validator to catch errors that `nbconvert` may not surface (cell exceptions, charts that fell back to text/plain, blank charts with constant data):

```bash
validate-notebook analysis.ipynb
```

If it reports issues, fix the failing cells and re-execute. Do **not** use `--allow-errors` — it silently embeds tracebacks in cell outputs that the user will see in the rendered report.

### Preview notebooks in chat

After creating or updating a notebook, set the active chat preview to the notebook file:

```text
set_file_preview(
  path="/home/claude/analysis.ipynb",
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
| `scipy` | Scientific computing, optimization | cached |
| `scikit-learn` | Machine learning algorithms | cached |

```python
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
model = LinearRegression().fit(X_train, y_train)
predictions = model.predict(X_test)
```

## Database Connectivity

| Package | Purpose | Status |
|---------|---------|--------|
| `requests` | Call built-in SQL data proxy (`DATA_PROXY_URL`) from sandbox scripts | cached |
| `sqlalchemy` | Python ORM and database toolkit | cached |
| `psycopg` | PostgreSQL driver | cached |
| `pymysql` | MySQL driver | `uv add pymysql` |
| `google-cloud-bigquery` | BigQuery client | cached |
| `google-cloud-bigquery-storage` | BigQuery Storage API client for faster downloads | cached |
| `google-auth` | Google authentication (used for BigQuery tokens) | cached |

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

### Sandbox/container scripts (secondary: `DATA_PROXY_URL`)

Inside sandbox/container scripts, you can call the HTTP proxy via `DATA_PROXY_URL`.
No bearer token is required; requests are authenticated by sandbox-host identity headers.
Keep queries bounded (`LIMIT`, selective `WHERE`) to avoid very large responses.

```python
import os
import pandas as pd
import requests

data_proxy_url = os.environ["DATA_PROXY_URL"].rstrip("/")

postgres = requests.post(
    f"{data_proxy_url}/postgres/query",
    json={
        "mode": "read",
        "host": "your-postgres-host",
        "user": "username",
        "password": "password",
        "database": "analytics",
        "query": "SELECT * FROM users WHERE id = $1 ORDER BY id LIMIT 100",
        "params": [123],
        "sslmode": "require",
    },
    timeout=60,
).json()

df = pd.DataFrame(postgres.get("recordset", []))
print(df.head())

postgres_modify = requests.post(
    f"{data_proxy_url}/postgres/query",
    json={
        "mode": "modify",
        "host": "your-postgres-host",
        "user": "username",
        "password": "password",
        "database": "analytics",
        "query": "UPDATE users SET last_seen_at = NOW() WHERE id = $1",
        "params": [123],
        "sslmode": "require",
    },
    timeout=60,
).json()

rows_affected = (postgres_modify.get("rowsAffected") or [0])[0]
print(rows_affected)
```

### Direct drivers (preferred local fallback in containers)

For sandbox/container code, native drivers are the primary fallback when proxy access is unnecessary.
Use this path when the user explicitly asks for direct connectivity or when local direct access is simpler.

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

### BigQuery

**Important:** BigQuery connections in camelAI use **OAuth access tokens**, not service account JSON files directly. The platform automatically generates short-lived access tokens from the user's service account JSON key and exposes them as environment variables. Always use this token-based approach.

When a BigQuery integration named e.g. "Production" is connected, these env vars are available:
- `INT_BIGQUERY_PRODUCTION_ACCESS_TOKEN` — short-lived OAuth token (auto-refreshed by the platform)
- `INT_BIGQUERY_PRODUCTION_PROJECT_ID` — the GCP project ID

```python
import os
from google.cloud import bigquery
from google.oauth2.credentials import Credentials

# Get the access token and project from environment variables.
# Replace PRODUCTION with the actual integration name (uppercased, non-alphanumeric → underscores).
access_token = os.environ["INT_BIGQUERY_PRODUCTION_ACCESS_TOKEN"]
project_id = os.environ["INT_BIGQUERY_PRODUCTION_PROJECT_ID"]

# Create client using the OAuth access token — do NOT use from_service_account_json()
credentials = Credentials(token=access_token)
client = bigquery.Client(project=project_id, credentials=credentials)

df = client.query("SELECT * FROM dataset.table").to_dataframe()
```

**Do NOT** use `bigquery.Client.from_service_account_json()` or try to read a service account JSON file. The raw service account key is never available in the container — only the derived access token is exposed.

## File Formats

| Package | Purpose | Status |
|---------|---------|--------|
| `pyarrow` | Parquet, Arrow files | cached |
| `openpyxl` | Excel (.xlsx) read/write | cached |
| `xlsxwriter` | Excel creation with formatting | cached |
| `pdfplumber` | PDF text and table extraction | cached |
| `python-docx` | Word documents | cached |
| `python-pptx` | PowerPoint files | cached |

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

Database connection credentials are available as environment variables in deployed workers (same `INT_*` env vars documented above), so dashboards can query databases directly at runtime.

## Additional Packages

| Package | Purpose | Status |
|---------|---------|--------|
| `statsmodels` | Statistical modeling, time series | cached |
| `xgboost` | Gradient boosting | cached |
| `geopandas` | Geospatial data | `uv add geopandas` |
| `opencv-python-headless` | Computer vision | `uv add opencv-python-headless` |
