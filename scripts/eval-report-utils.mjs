export const FINALIZE_MAX_ATTEMPTS = 3;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryEvalFinalize(
  operation,
  {
    attempts = FINALIZE_MAX_ATTEMPTS,
    baseDelayMs = 250,
    sleep = defaultSleep,
    onRetry,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry?.(error, attempt, attempts);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export function matrixBatchUrl({
  batchId,
  dryRun,
  reportedRunCount,
  env = process.env,
}) {
  if (dryRun || reportedRunCount < 1 || env.EVAL_REPORT !== "1") return undefined;
  const reportBase = (env.EVAL_REPORT_BASE ?? "https://evals.camelai.dev").replace(
    /\/+$/,
    "",
  );
  return `${reportBase}/batches/${encodeURIComponent(batchId)}`;
}

export function extractReportedRunUrls(output) {
  return [
    ...new Set(
      [...output.matchAll(
        /^Reported eval run: (https?:\/\/\S+\/runs\/[A-Za-z0-9._~%-]+)(?:\s|$)/gm,
      )].map((match) => match[1]),
    ),
  ];
}
