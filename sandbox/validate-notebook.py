#!/usr/bin/env python3
"""Validate an executed notebook for chart errors and blank charts."""

import json
import re
import sys


def validate_notebook(path: str) -> str:
    with open(path) as f:
        nb = json.load(f)

    issues = []

    for i, cell in enumerate(nb["cells"]):
        if cell["cell_type"] != "code":
            continue
        outputs = cell.get("outputs", [])

        # Check 1: Cell-level errors (display/render exceptions that nbconvert misses)
        for out in outputs:
            if out["output_type"] == "error":
                issues.append(f"Cell {i} ERROR: {out['ename']}: {out['evalue']}")

        # Check 2: Chart fell back to text/plain (serialization failed)
        # Check per-output so a rich DataFrame in the same cell doesn't mask a broken chart
        for out in outputs:
            if out.get("output_type") not in ("execute_result", "display_data"):
                continue
            data = out.get("data", {})
            plain = "".join(data.get("text/plain", []))
            is_chart = any(t in plain for t in ("alt.Chart", "alt.Layer", "alt.HConcat", "alt.VConcat"))
            has_rich = bool(set(data.keys()) - {"text/plain"})
            if is_chart and not has_rich:
                issues.append(f"Cell {i} ERROR: chart rendered as text/plain only")

        # Check 3: Vega-Lite spec with all-identical quantitative data (blank chart)
        for out in outputs:
            spec = _extract_vegalite_spec(out)
            if spec is None:
                continue

            rows = []
            for ds in spec.get("datasets", {}).values():
                if isinstance(ds, list):
                    rows.extend(ds)
            if not rows:
                v = spec.get("data", {})
                if isinstance(v, dict) and isinstance(v.get("values"), list):
                    rows = v["values"]

            for field in _quant_fields(spec):
                vals = [r[field] for r in rows if isinstance(r.get(field), (int, float))]
                if len(vals) > 1 and max(vals) == min(vals):
                    issues.append(f"Cell {i} WARNING: field '{field}' all identical ({vals[0]})")

    return "OK" if not issues else "\n".join(issues)


def _extract_vegalite_spec(out):
    """Extract a Vega-Lite spec from an output's MIME bundle.

    Checks application/vnd.vegalite.v*+json first (direct MIME), then falls
    back to parsing the spec out of embedded HTML (vegaEmbed script tag).
    """
    data = out.get("data", {})

    # Direct Vega-Lite MIME bundle (e.g. application/vnd.vegalite.v5+json)
    for key, value in data.items():
        if key.startswith("application/vnd.vegalite.") and key.endswith("+json"):
            if isinstance(value, dict):
                return value
            if isinstance(value, str):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    pass

    # Fallback: parse spec from embedded HTML (vegaEmbed call)
    html_parts = data.get("text/html")
    if not html_parts:
        return None
    html = "".join(html_parts)
    m = re.search(r"\}\)\((\{.*?\})\s*,\s*\{[\"']mode", html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _quant_fields(spec, out=None):
    if out is None:
        out = set()
    for enc in spec.get("encoding", {}).values():
        if isinstance(enc, dict) and enc.get("type") == "quantitative" and enc.get("field"):
            out.add(enc["field"])
    for layer in spec.get("layer", []):
        _quant_fields(layer, out)
    for item in spec.get("concat", spec.get("hconcat", spec.get("vconcat", []))):
        _quant_fields(item, out)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <notebook.ipynb>", file=sys.stderr)
        sys.exit(2)
    result = validate_notebook(sys.argv[1])
    print(result)
    sys.exit(0 if result == "OK" else 1)
