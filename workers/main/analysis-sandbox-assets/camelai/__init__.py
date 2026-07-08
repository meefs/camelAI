"""camelAI in-sandbox helpers for notebooks and analysis scripts.

Preinstalled on PYTHONPATH in the analysis container. Wraps the workspace
connections RPC (``CAMELAI_CONNECTIONS_RPC_URL``) so notebook authors never
hand-roll urllib calls or reverse-engineer the MCP response nesting:

    from camelai import bq
    df = bq.query("SELECT title, score FROM stories LIMIT 100")
    df = bq.query_full("SELECT * FROM big_table")   # unlimited rows via R2 export

    from camelai import connections
    df = connections.query("postgres", "SELECT * FROM users LIMIT 100")
    df = connections.query_full("clickhouse", "SELECT * FROM events")

Pure stdlib at import time; pandas/duckdb are imported lazily by the functions
that return DataFrames (both are in the container's default stack).
"""

from . import bq, connections
from .connections import ConnectionsRpcError

__all__ = ["bq", "connections", "ConnectionsRpcError"]
