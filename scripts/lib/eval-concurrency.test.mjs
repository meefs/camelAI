import assert from "node:assert/strict";
import test from "node:test";

import { resolveEvalConcurrency, runEvalWaves } from "./eval-concurrency.mjs";

test("automatic eval concurrency oversubscribes CPUs while max uses available memory", () => {
  assert.equal(resolveEvalConcurrency("auto", 36, { cpus: 16, totalMemory: 125 * 1024 ** 3 }), 32);
  assert.equal(resolveEvalConcurrency("max", 36, { cpus: 16, totalMemory: 125 * 1024 ** 3 }), 36);
  assert.equal(resolveEvalConcurrency("max", 5, { cpus: 16, totalMemory: 125 * 1024 ** 3 }), 5);
  assert.equal(resolveEvalConcurrency("8", 36, { cpus: 16, totalMemory: 6 * 1024 ** 3 }), 3);
  assert.equal(resolveEvalConcurrency("24", 36, { cpus: 8, totalMemory: 64 * 1024 ** 3 }), 24);
  assert.throws(() => resolveEvalConcurrency("zero", 2), /--concurrency/);
});

test("eval waves never exceed the requested concurrency and wait before cleanup", async () => {
  let active = 0;
  let maximum = 0;
  const cleanupSnapshots = [];
  const results = await runEvalWaves(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    },
    async (progress) => cleanupSnapshots.push({ active, ...progress }),
  );
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
  assert.deepEqual(cleanupSnapshots.map(({ active }) => active), [0, 0, 0]);
});
