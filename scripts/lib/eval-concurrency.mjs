import os from "node:os";

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_MEMORY_PER_EVAL_GIB = 2;
const AUTO_IO_OVERSUBSCRIPTION = 2;

export function resolveEvalConcurrency(
  value,
  totalRuns,
  hardware = { cpus: os.availableParallelism(), totalMemory: os.totalmem() },
) {
  const runCount = Math.max(1, Number(totalRuns) || 1);
  const cpuLimit = Math.max(1, Math.floor(Number(hardware.cpus) || 1));
  const memoryLimit = Math.max(
    1,
    Math.floor((Number(hardware.totalMemory) || BYTES_PER_GIB) / (DEFAULT_MEMORY_PER_EVAL_GIB * BYTES_PER_GIB)),
  );
  // Agent evals spend most of their wall time waiting on inference, containers,
  // and live deploys, so CPU count is intentionally oversubscribed in auto mode.
  const automatic = Math.min(
    runCount,
    cpuLimit * AUTO_IO_OVERSUBSCRIPTION,
    memoryLimit,
  );
  const maximum = Math.min(runCount, memoryLimit);
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "auto") return automatic;
  if (normalized === "max") return maximum;
  const requested = Number(normalized);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("--concurrency must be auto, max, or a positive integer");
  }
  return Math.min(runCount, requested, memoryLimit);
}

/**
 * Run bounded work in synchronization waves. The barrier between waves lets the
 * caller safely reap leaked global resources without touching active siblings.
 */
export async function runEvalWaves(items, concurrency, runItem, afterWave = async () => {}) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const wave = items.slice(offset, offset + concurrency);
    const waveResults = await Promise.all(wave.map((item, index) => runItem(item, offset + index)));
    results.push(...waveResults);
    await afterWave({
      waveNumber: Math.floor(offset / concurrency) + 1,
      completed: results.length,
      total: items.length,
    });
  }
  return results;
}
