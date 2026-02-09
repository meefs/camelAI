---
name: data-analysis
description: Analyze data using pre-installed Python and SQL tools. Use this skill when the user asks to process CSVs, Excel, Parquet, PDFs, Word docs, or PowerPoint files, query databases (PostgreSQL, MySQL, SQLite, SQL Server, BigQuery), create visualizations, or perform data analysis. Handles pandas, polars, DuckDB for data processing, matplotlib/seaborn/plotly for visualization, scikit-learn for ML, and database connectivity via SQLAlchemy, usql, the google-cloud-bigquery client with OAuth access tokens, and the Chiridion MS SQL Proxy API for SQL Server. For live dashboards or data apps, read the developing-software skill.
license: Complete terms in LICENSE.txt
---

# Data Analysis Tools

This skill provides pre-installed tools for data analysis, database querying, and visualization.

## Database CLI

### usql - Universal SQL CLI

Connect to any database from the command line:

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

SQLite CLI is also available for local databases:

```bash
sqlite3 data.db "SELECT * FROM users LIMIT 10"
```

## Python Data Processing

### Core Libraries (Pre-installed)

| Package | Purpose |
|---------|---------|
| `pandas` | DataFrames and data manipulation |
| `numpy` | Numerical computing |
| `polars` | Fast DataFrame library (Rust-based) |
| `duckdb` | In-process SQL analytics |

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

### Visualization (Pre-installed)

| Package | Purpose |
|---------|---------|
| `matplotlib` | Static plots and charts |
| `seaborn` | Statistical visualization |
| `plotly` | Interactive charts |

```python
import matplotlib.pyplot as plt
import seaborn as sns

# Matplotlib
plt.figure(figsize=(10, 6))
plt.plot(df["date"], df["value"])
plt.savefig("chart.png")

# Seaborn
sns.barplot(data=df, x="category", y="amount")
plt.savefig("barplot.png")

# Plotly (interactive HTML)
import plotly.express as px
fig = px.line(df, x="date", y="value")
fig.write_html("chart.html")
```

### Scientific Computing & ML (Pre-installed)

| Package | Purpose |
|---------|---------|
| `scipy` | Scientific computing, optimization |
| `scikit-learn` | Machine learning algorithms |

```python
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
model = LinearRegression().fit(X_train, y_train)
predictions = model.predict(X_test)
```

### Database Connectivity (Pre-installed)

| Package | Purpose |
|---------|---------|
| `sqlalchemy` | Python ORM and database toolkit |
| `psycopg` | PostgreSQL driver |
| `pymysql` | MySQL driver |
| `google-cloud-bigquery` | BigQuery client |
| `google-auth` | Google authentication (used for BigQuery tokens) |

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

#### BigQuery

**Important:** BigQuery connections in Chiridion use **OAuth access tokens**, not service account JSON files directly. The platform automatically generates short-lived access tokens from the user's service account JSON key and exposes them as environment variables. Always use this token-based approach.

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

#### MS SQL Server

MS SQL Server connections use the **Chiridion Data Proxy API**. Direct drivers like `pymssql` or `pyodbc` are not available in the container. Instead, use the HTTP API with a signed token.

When you need to query MS SQL Server, a `DATA_PROXY_TOKEN` environment variable is available for authentication.

```python
import os
import requests

token = os.environ["DATA_PROXY_TOKEN"]
base_url = os.environ.get("DATA_PROXY_URL", "https://chiridion.ai/api")

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

**Note:** The `usql sqlserver://` CLI shown above also works for interactive exploration but the HTTP API is preferred for programmatic access within scripts.

### File Formats (Pre-installed)

| Package | Purpose |
|---------|---------|
| `pyarrow` | Parquet, Arrow files |
| `openpyxl` | Excel (.xlsx) read/write |
| `xlsxwriter` | Excel creation with formatting |
| `pdfplumber` | PDF text and table extraction |
| `python-docx` | Word documents |
| `python-pptx` | PowerPoint files |

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

## On-Demand Packages

These are NOT pre-installed. Install with `uv pip install --system <package>`:

| Package | Purpose |
|---------|---------|
| `statsmodels` | Statistical modeling, time series |
| `xgboost` | Gradient boosting |
| `geopandas` | Geospatial data |
| `opencv-python-headless` | Computer vision |
