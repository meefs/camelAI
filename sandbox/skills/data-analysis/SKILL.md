---
name: data-analysis
description: Analyze data using Python and SQL tools. Use when the user asks to process CSVs, Excel, Parquet, PDFs, Word docs, or PowerPoint files, query databases (PostgreSQL, MySQL, SQLite, SQL Server, BigQuery), create charts or visualizations, or perform any data analysis. For live dashboards or data apps, read the developing-software skill.
license: Complete terms in LICENSE.txt
---

# Data Analysis

## Package Installation

Install Python packages on-demand with `uv pip install --system <package>`. Installs persist across sessions. Before importing a package, check if it's installed (`python -c "import pkg"`) and install if missing.

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

| Package | Purpose | Install |
|---------|---------|---------|
| `pandas` | DataFrames and data manipulation | `uv pip install --system pandas` |
| `numpy` | Numerical computing | `uv pip install --system numpy` |
| `polars` | Fast DataFrame library (Rust-based) | `uv pip install --system polars` |
| `duckdb` | In-process SQL analytics | `uv pip install --system duckdb` |

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

| Package | Purpose | Install |
|---------|---------|---------|
| `altair` | Declarative charts (Vega-Lite) — **preferred** | `uv pip install --system altair` |
| `plotly` | Interactive charts — use for 3D, maps, finance | `uv pip install --system plotly` |
| `matplotlib` | Static plots (fallback) | `uv pip install --system matplotlib` |
| `seaborn` | Statistical visualization (fallback) | `uv pip install --system seaborn` |

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

Only use `df.style` when the user explicitly requests conditional formatting, cell-level color coding, or other per-cell visual logic that can't be achieved with a plain table.

## Jupyter Notebook Workflow (Preferred)

For exploratory analysis, prefer delivering results as a Jupyter notebook (`.ipynb`) instead of a standalone `.py` script with separate chart/image files. Notebooks combine code, visual output, and markdown conclusions in one artifact.

### Build notebooks incrementally

- Use `NotebookEdit` for notebook changes (add/update markdown and code cells) instead of hand-editing raw JSON.
- Keep a narrative flow:
  - markdown cell: objective and dataset context
  - code cell: data loading/cleaning
  - markdown cell: what to look for
  - code cell: chart/query
  - markdown cell: interpretation and takeaway

### Execute notebooks

```bash
# Install tools if needed
uv pip install --system jupyter nbconvert

# Execute in place so outputs are saved into the notebook file
python -m jupyter nbconvert --to notebook --execute --inplace analysis.ipynb
```

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

| Package | Purpose | Install |
|---------|---------|---------|
| `scipy` | Scientific computing, optimization | `uv pip install --system scipy` |
| `scikit-learn` | Machine learning algorithms | `uv pip install --system scikit-learn` |

```python
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
model = LinearRegression().fit(X_train, y_train)
predictions = model.predict(X_test)
```

## Database Connectivity

| Package | Purpose | Install |
|---------|---------|---------|
| `sqlalchemy` | Python ORM and database toolkit | `uv pip install --system sqlalchemy` |
| `psycopg` | PostgreSQL driver | `uv pip install --system psycopg` |
| `pymysql` | MySQL driver | `uv pip install --system pymysql` |
| `google-cloud-bigquery` | BigQuery client | `uv pip install --system google-cloud-bigquery` |
| `google-auth` | Google authentication (used for BigQuery tokens) | `uv pip install --system google-auth` |

```python
from sqlalchemy import create_engine
import pandas as pd

# PostgreSQL
engine = create_engine("postgresql+psycopg://user:pass@host/db")
df = pd.read_sql("SELECT * FROM users", engine)

# MySQL
engine = create_engine("mysql+pymysql://user:pass@host/db")
df = pd.read_sql("SELECT * FROM orders", engine)
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

### MS SQL Server

MS SQL Server connections use the **camelAI Data Proxy API**. Direct drivers like `pymssql` or `pyodbc` are not available in the container. Instead, use the HTTP API with a signed token.

When you need to query MS SQL Server, a `DATA_PROXY_TOKEN` environment variable is available for authentication.

```python
import os
import requests

token = os.environ["DATA_PROXY_TOKEN"]
base_url = os.environ.get("DATA_PROXY_URL", "https://camelai.dev/api")

response = requests.post(
    f"{base_url}/mssql/query",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    },
    json={
        "server": "your-server.database.windows.net",
        "user": "username",
        "password": "password",
        "database": "mydb",
        "query": "SELECT * FROM users WHERE id = @id",
        "params": {"id": 123},
        "encrypt": True  # Use TLS (required for Azure SQL)
    }
)

result = response.json()
# result["recordset"] = [{"id": 123, "name": "John", ...}]
# result["rowsAffected"] = [1]
```

**Request Options:**
| Field | Required | Description |
|-------|----------|-------------|
| `server` | Yes | SQL Server hostname |
| `user` | Yes | Username |
| `password` | Yes | Password |
| `query` | Yes | SQL query with `@param` placeholders |
| `database` | No | Database name (default: `master`) |
| `port` | No | Port (default: `1433`) |
| `params` | No | Parameter values for the query |
| `encrypt` | No | Use TLS (default: `true`) |
| `trustServerCertificate` | No | Trust self-signed certs (default: `true`) |
| `timeout` | No | Query timeout in ms (default: `30000`) |

**Transactions:** For atomic multi-statement operations, wrap queries in `BEGIN TRANSACTION`/`COMMIT`:
```python
response = requests.post(
    f"{base_url}/mssql/query",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    },
    json={
        "server": "your-server.database.windows.net",
        "user": "username",
        "password": "password",
        "database": "mydb",
        "query": """
            BEGIN TRANSACTION;
            INSERT INTO orders (id, amount) VALUES (@id, @amt);
            UPDATE inventory SET qty = qty - 1 WHERE product_id = @pid;
            COMMIT;
        """,
        "params": {"id": 1, "amt": 100, "pid": 42}
    }
)
```

**Note:** The `usql sqlserver://` CLI also works for interactive exploration but the HTTP API is preferred for programmatic access within scripts.

## File Formats

| Package | Purpose | Install |
|---------|---------|---------|
| `pyarrow` | Parquet, Arrow files | `uv pip install --system pyarrow` |
| `openpyxl` | Excel (.xlsx) read/write | `uv pip install --system openpyxl` |
| `xlsxwriter` | Excel creation with formatting | `uv pip install --system xlsxwriter` |
| `pdfplumber` | PDF text and table extraction | `uv pip install --system pdfplumber` |
| `python-docx` | Word documents | `uv pip install --system python-docx` |
| `python-pptx` | PowerPoint files | `uv pip install --system python-pptx` |

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

| Package | Purpose | Install |
|---------|---------|---------|
| `statsmodels` | Statistical modeling, time series | `uv pip install --system statsmodels` |
| `xgboost` | Gradient boosting | `uv pip install --system xgboost` |
| `geopandas` | Geospatial data | `uv pip install --system geopandas` |
| `opencv-python-headless` | Computer vision | `uv pip install --system opencv-python-headless` |
