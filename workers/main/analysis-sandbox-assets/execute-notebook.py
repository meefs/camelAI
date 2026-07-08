#!/usr/bin/env python3
"""Execute a notebook in place, saving after every cell.

Replaces `jupyter nbconvert --execute --inplace` in the analysis sandbox.
nbconvert only writes the notebook after the WHOLE run succeeds, so a failure
in cell N discards the outputs of cells 1..N-1 — the partial results that make
the failure debuggable. This runner persists the notebook after each executed
cell and once more on the way out, so a failed run leaves behind every
completed cell's outputs plus the failing cell's error output.

Contract (matched to what analysis-service expects from nbconvert):
- exit 0 on success, non-zero on a cell error
- the Python traceback (nbclient's CellExecutionError) goes to stderr
- the notebook file is updated in place
"""

import sys

import nbformat
from nbclient.client import NotebookClient


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <notebook.ipynb>", file=sys.stderr)
        return 2

    path = sys.argv[1]
    nb = nbformat.read(path, as_version=4)
    kernel_name = (nb.metadata.get("kernelspec") or {}).get("name") or "python3"
    client = NotebookClient(nb, kernel_name=kernel_name, allow_errors=False)

    def save(**_kwargs) -> None:
        nbformat.write(nb, path)

    # Called after each cell finishes (success or error output recorded).
    client.on_cell_executed = save

    try:
        client.execute()
    finally:
        # The failing cell's error output is recorded on the cell before
        # CellExecutionError propagates; persist it too.
        nbformat.write(nb, path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
