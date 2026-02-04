---
name: data-analysis
description: Analyze data using Python and SQL tools. Use this skill when the user asks to process CSVs, query databases, create visualizations, or perform data analysis.
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

# BigQuery (with credentials)
usql bigquery://project/dataset
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

```python
from sqlalchemy import create_engine
import pandas as pd

# PostgreSQL
engine = create_engine("postgresql+psycopg://user:pass@host/db")
df = pd.read_sql("SELECT * FROM users", engine)

# MySQL
engine = create_engine("mysql+pymysql://user:pass@host/db")
df = pd.read_sql("SELECT * FROM orders", engine)

# BigQuery
from google.cloud import bigquery
client = bigquery.Client.from_service_account_json("/path/to/key.json")
df = client.query("SELECT * FROM dataset.table").to_dataframe()
```

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

## On-Demand Packages

These are NOT pre-installed. Install with `uv pip install --system <package>`:

| Package | Purpose |
|---------|---------|
| `statsmodels` | Statistical modeling, time series |
| `xgboost` | Gradient boosting |
| `geopandas` | Geospatial data |
| `opencv-python-headless` | Computer vision |
