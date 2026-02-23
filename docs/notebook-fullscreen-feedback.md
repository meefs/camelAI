# Fullscreen Modes Implementation — Feedback

Review of the initial implementation against the plan. Three pieces of user feedback, plus two code-review observations.

Items 2, 3, and both nits were already implemented by the coding agent. Item 1 (pandas truncation) was implemented but the Dockerfile path is wrong — the fix below corrects it.

---

## 1. Pandas truncation: More data in, not just better display

### The problem

The expanded table view is only useful when the underlying data is rich. But pandas truncates HTML output **before it reaches us** — the `.ipynb` file literally contains at most ~10 rows and truncated cell text (e.g. `"5-job milestone strongly correlates with provi…"`). Text-wrap and column-resize can't recover data that was never serialized.

### Why the current Dockerfile approach doesn't work

The coding agent added this to `Dockerfile.sandbox`:

```dockerfile
COPY sandbox/ipython-startup/ /home/claude/.ipython/profile_default/startup/
RUN chown -R claude:claude /home/claude/.ipython
```

This won't work because `/home/claude` is volumetric storage — a bind-mounted host directory (`/srv/sandboxes/{sandboxName}`) that shadows anything `COPY`'d during `docker build`. Files placed there at build time are invisible at runtime.

### The fix: `IPYTHONDIR` environment variable

IPython checks the `IPYTHONDIR` env var to locate its config directory (defaults to `~/.ipython`, which resolves to `/home/claude/.ipython` for the `claude` user). By pointing it to a path **outside** `/home/claude`, the startup file survives the volume mount.

The execution chain:
1. Agent runs `uv run jupyter nbconvert --to notebook --execute --inplace notebook.ipynb`
2. `nbconvert --execute` starts an IPython kernel
3. IPython reads `$IPYTHONDIR` → finds `/opt/ipython`
4. Executes all `*.py` in `/opt/ipython/profile_default/startup/` before the first notebook cell
5. Pandas display options are set globally for the kernel session

`IPYTHONDIR` is an environment variable read at IPython runtime, not a Python path or install location. It works regardless of which venv IPython is running from.

### Changes needed

**Keep:** `sandbox/ipython-startup/00-display-defaults.py` — the file is correct as-is.

**Modify:** `services/sandbox-host/Dockerfile.sandbox` — replace the current IPython lines (76–78):

```dockerfile
# IPython startup defaults (pandas display settings for notebook HTML output)
COPY sandbox/ipython-startup/ /home/claude/.ipython/profile_default/startup/
RUN chown -R claude:claude /home/claude/.ipython
```

With:

```dockerfile
# IPython startup defaults (pandas display settings for notebook HTML output).
# IPYTHONDIR must live outside /home/claude — that path is a bind-mounted
# volume, so files COPY'd there at build time are shadowed at runtime.
ENV IPYTHONDIR=/opt/ipython
COPY sandbox/ipython-startup/ /opt/ipython/profile_default/startup/
RUN chown -R claude:claude /opt/ipython
```

`/opt/ipython` needs to be writable by the runtime user (`claude`) so IPython doesn't fall back to a temp directory and skip the intended startup profile.

**Keep:** `sandbox/skills/data-analysis/SKILL.md` — the current "Tabular output" wording is accurate. It says the sandbox pre-configures pandas defaults, which remains true with the `IPYTHONDIR` approach. The agent doesn't need to add `pd.set_option` calls manually.

---

## 2. Fullscreen charts should fill the container height ✅

> Already implemented by the coding agent.

### The problem

When a chart opens in fullscreen, the width stretches to fill the dialog but the height stays at the same small inline value (~280-320px). The chart should use the available vertical space.

### What was done

**(a)** `output-renderers.tsx` — `renderChart` accepts a `fullScreen` boolean and passes `fillContainer={fullScreen}` to both chart components. The inline call uses `renderChart(false)`, the fullscreen call uses `renderChart(true)`.

**(b)** `plotly-chart.tsx` — added `fillContainer?: boolean` prop. When true: deletes `layout.height` entirely (removes the `Math.max(240, Math.min(900, ...))` clamp), sets the plot div to `style={{ width: '100%', height: '100%' }}`, and adds `max-w-[1800px] mx-auto` to cap width on ultrawide monitors.

**(c)** `vega-lite-chart.tsx` — added `fillContainer?: boolean` prop. When true: sets `height: 'container'` in the Vega spec, sets the container div to `style={{ width: '100%', height: '100%' }}`, and adds `max-w-[1800px] mx-auto`.

**(d)** `output-renderers.tsx` — the fullscreen chart wrapper uses `flex h-full min-h-0 items-center justify-center` to ensure height flows down, with a `max-w-[1800px]` inner div.

---

## 3. Remove text labels from expand and download buttons ✅

> Already implemented by the coding agent.

### The problem

The "Expand" and "Download as CSV" text labels on the inline chart/table action bars are unnecessary. The `Maximize2` and `Download` icons are self-explanatory and standard. Removing the labels makes the UI cleaner, especially in the narrow preview panel where space is tight.

### What was done

**(a)** `notebook-table.tsx` — caption bar buttons are icon-only. Both expand and download buttons render just their icon with `aria-label` for accessibility.

**(b)** `output-action-bar.tsx` — the Download dropdown trigger shows only the icon and chevron, no "Download" text.

**(c)** `table-viewer.tsx` — the fullscreen table toolbar keeps its text labels ("Wrap", "Download as CSV") since the fullscreen toolbar has ample space and the actions are less immediately obvious in context.

---

## Additional observations from code review

### Nit: Conditional rendering for fullscreen charts ✅

> Already implemented by the coding agent.

`ChartOutputWithActions` in `output-renderers.tsx` conditionally renders the `FullScreenDialog` with `{isFullScreen && (<FullScreenDialog ...>)}`. This avoids mounting the chart and loading CDN libraries when the dialog is closed, and prevents the brief flash of loading the chart a second time when expanding.

### Nit: CSV filename in `TableViewer` vs `NotebookTable`

`TableViewer` generates a slug-based filename from the title (`sanitizeCsvFilename(title)`), while `NotebookTable` always uses the hardcoded `'table-data.csv'`. Consider making `NotebookTable` also use a smarter filename — but this is minor and can be a follow-up.
