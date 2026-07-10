function firstMeaningfulLine(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => {
      if (!line) return false;
      if (/^[⎯\-\s]+$/.test(line)) return false;
      if (/^Unhandled (?:Rejection|Exception)/i.test(line)) return false;
      if (/^Vitest caught \d+ unhandled errors?/i.test(line)) return false;
      if (/^This might cause false positive tests/i.test(line)) return false;
      if (/^Make sure to resolve/i.test(line)) return false;
      return true;
    });
}

function classifyFilteredHarnessError(piece) {
  if (piece.includes("callToolEnvelope")) return "enveloped_tool_duplicate";
  if (piece.includes("Screenshot capture requires the BROWSER binding")) {
    return "missing_browser_binding_screenshot";
  }
  if (piece.includes("Screenshot capture requires the DISPATCHER binding")) {
    return "missing_dispatcher_binding_screenshot";
  }
  if (piece.includes("Browser sessions require the BROWSER binding")) {
    return "missing_browser_binding_session";
  }
  if (piece.includes("DISPATCHER service binding is not configured")) {
    return "missing_dispatcher_binding";
  }
  if (piece.includes("ServiceStub serialization requires the 'experimental' compat flag")) {
    return "servicestub_experimental_compat_missing";
  }
  // Source-manifest failures are intentionally absent. A missing first-build
  // cache entry is avoided before readFile; any remaining manifest rejection is
  // a real build/materialization failure and must fail the eval.
  return null;
}

export function extractVitestUnhandledErrors(output) {
  if (!/Unhandled Errors/i.test(output)) {
    return { harnessErrors: [], filteredHarnessErrors: [] };
  }
  const pieces = output.split(/Unhandled (?:Rejection|Exception)/i).slice(1);
  const harnessErrors = [];
  const filteredHarnessErrors = [];
  for (const piece of pieces) {
    const line = firstMeaningfulLine(piece);
    if (!line) continue;
    const filteredReason = classifyFilteredHarnessError(piece);
    if (filteredReason) {
      filteredHarnessErrors.push({
        tool: "harness",
        reason: filteredReason,
        output: line.slice(0, 500),
      });
      continue;
    }
    harnessErrors.push({
      tool: "harness",
      reason: "vitest_unhandled_error",
      output: line.slice(0, 500),
    });
  }
  return { harnessErrors, filteredHarnessErrors };
}
