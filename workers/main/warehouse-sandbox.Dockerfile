# Sealed analytics container for the warehouse tier (WarehouseSandbox).
#
# Heavy cross-source DuckDB work runs here, off the Durable Object. At runtime
# the container is sealed (no internet); data arrives only via a read-only R2
# mount of the workspace's staged exports. So the analytics stack must be baked
# in at build time (build has network, runtime does not).
#
# Use the SDK's `-python` image variant (Python 3.11 + pip + venv, with pandas/
# numpy preinstalled) so runCode(language:"python") works. The tag MUST match the
# @cloudflare/sandbox npm version (0.12.0). Do NOT set ENTRYPOINT — the base
# image's entrypoint starts the sandbox HTTP API server; we only add packages.
FROM docker.io/cloudflare/sandbox:0.12.0-python

# DuckDB (+ Arrow) for reading the staged Parquet/NDJSON exports and doing
# cross-source joins/aggregations. pandas/numpy are already in the base image.
# The variant ships pip as `pip3` only (no `pip` symlink), so invoke via
# `python3 -m pip` to be robust.
RUN python3 -m pip install --no-cache-dir duckdb pyarrow
