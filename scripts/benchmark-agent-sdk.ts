#!/usr/bin/env npx tsx
/**
 * Benchmark: Agent SDK one-shot vs session mode
 * Measures wall clock time and CPU usage - pure SDK, no CLI
 */

import {
  unstable_v2_prompt,
  unstable_v2_createSession,
} from '@anthropic-ai/claude-agent-sdk'

const PROMPT = 'Say "hello" and nothing else.'
const NUM_ITERATIONS = 5

interface BenchmarkResult {
  name: string
  iterations: number
  totalWallTimeMs: number
  avgWallTimeMs: number
  totalCpuUserMs: number
  totalCpuSystemMs: number
  avgCpuUserMs: number
  avgCpuSystemMs: number
  perIterationTimes: number[]
}

function formatResult(result: BenchmarkResult): string {
  return `
${result.name}
${'='.repeat(result.name.length)}
Iterations: ${result.iterations}
Total wall time: ${result.totalWallTimeMs.toFixed(0)}ms
Avg wall time per iteration: ${result.avgWallTimeMs.toFixed(0)}ms
Per-iteration times: [${result.perIterationTimes.map((t) => t.toFixed(0)).join(', ')}]ms
Total CPU (user): ${result.totalCpuUserMs.toFixed(0)}ms
Total CPU (system): ${result.totalCpuSystemMs.toFixed(0)}ms
Avg CPU per iteration (user): ${result.avgCpuUserMs.toFixed(0)}ms
Avg CPU per iteration (system): ${result.avgCpuSystemMs.toFixed(0)}ms
`
}

/**
 * Benchmark 1: SDK one-shot mode (unstable_v2_prompt)
 * Each iteration calls prompt() - new session each time
 */
async function benchmarkSdkOneShot(): Promise<BenchmarkResult> {
  const perIterationTimes: number[] = []
  const startCpu = process.cpuUsage()
  const startTime = performance.now()

  for (let i = 0; i < NUM_ITERATIONS; i++) {
    const iterStart = performance.now()

    await unstable_v2_prompt(PROMPT, {
      model: 'claude-sonnet-4-5-20250929',
    })

    perIterationTimes.push(performance.now() - iterStart)
  }

  const endTime = performance.now()
  const endCpu = process.cpuUsage(startCpu)

  const totalWallTimeMs = endTime - startTime
  const totalCpuUserMs = endCpu.user / 1000
  const totalCpuSystemMs = endCpu.system / 1000

  return {
    name: 'SDK One-Shot (unstable_v2_prompt)',
    iterations: NUM_ITERATIONS,
    totalWallTimeMs,
    avgWallTimeMs: totalWallTimeMs / NUM_ITERATIONS,
    totalCpuUserMs,
    totalCpuSystemMs,
    avgCpuUserMs: totalCpuUserMs / NUM_ITERATIONS,
    avgCpuSystemMs: totalCpuSystemMs / NUM_ITERATIONS,
    perIterationTimes,
  }
}

/**
 * Benchmark 2: SDK session mode (unstable_v2_createSession)
 * Single session, multiple send/receive cycles
 */
async function benchmarkSdkSession(): Promise<BenchmarkResult> {
  const perIterationTimes: number[] = []
  const startCpu = process.cpuUsage()
  const startTime = performance.now()

  const session = unstable_v2_createSession({
    model: 'claude-sonnet-4-5-20250929',
  })

  try {
    for (let i = 0; i < NUM_ITERATIONS; i++) {
      const iterStart = performance.now()

      await session.send(PROMPT)
      for await (const msg of session.stream()) {
        if (msg.type === 'result') break
      }

      perIterationTimes.push(performance.now() - iterStart)
    }
  } finally {
    session.close()
  }

  const endTime = performance.now()
  const endCpu = process.cpuUsage(startCpu)

  const totalWallTimeMs = endTime - startTime
  const totalCpuUserMs = endCpu.user / 1000
  const totalCpuSystemMs = endCpu.system / 1000

  return {
    name: 'SDK Session Mode (createSession + send/receive)',
    iterations: NUM_ITERATIONS,
    totalWallTimeMs,
    avgWallTimeMs: totalWallTimeMs / NUM_ITERATIONS,
    totalCpuUserMs,
    totalCpuSystemMs,
    avgCpuUserMs: totalCpuUserMs / NUM_ITERATIONS,
    avgCpuSystemMs: totalCpuSystemMs / NUM_ITERATIONS,
    perIterationTimes,
  }
}

/**
 * Benchmark 3: SDK session mode - measure session creation overhead separately
 */
async function benchmarkSdkSessionWithCreationTime(): Promise<{
  sessionCreation: BenchmarkResult
  subsequentMessages: BenchmarkResult
}> {
  // Measure session creation + first message
  const creationTimes: number[] = []
  const creationStartCpu = process.cpuUsage()
  const creationStart = performance.now()

  for (let i = 0; i < NUM_ITERATIONS; i++) {
    const iterStart = performance.now()

    const session = unstable_v2_createSession({
      model: 'claude-sonnet-4-5-20250929',
    })
    await session.send(PROMPT)
    for await (const msg of session.stream()) {
      if (msg.type === 'result') break
    }
    session.close()

    creationTimes.push(performance.now() - iterStart)
  }

  const creationEnd = performance.now()
  const creationEndCpu = process.cpuUsage(creationStartCpu)

  // Measure subsequent messages on same session
  const subsequentTimes: number[] = []
  const subsequentStartCpu = process.cpuUsage()
  const subsequentStart = performance.now()

  const session = unstable_v2_createSession({
    model: 'claude-sonnet-4-5-20250929',
  })

  // First message (includes session setup)
  await session.send(PROMPT)
  for await (const msg of session.stream()) {
    if (msg.type === 'result') break
  }

  // Now measure subsequent messages only
  for (let i = 0; i < NUM_ITERATIONS; i++) {
    const iterStart = performance.now()

    await session.send(PROMPT)
    for await (const msg of session.stream()) {
      if (msg.type === 'result') break
    }

    subsequentTimes.push(performance.now() - iterStart)
  }

  session.close()

  const subsequentEnd = performance.now()
  const subsequentEndCpu = process.cpuUsage(subsequentStartCpu)

  const creationTotal = creationEnd - creationStart
  const creationCpuUser = creationEndCpu.user / 1000
  const creationCpuSystem = creationEndCpu.system / 1000

  const subsequentTotal = subsequentEnd - subsequentStart
  const subsequentCpuUser = subsequentEndCpu.user / 1000
  const subsequentCpuSystem = subsequentEndCpu.system / 1000

  return {
    sessionCreation: {
      name: 'New Session Per Message',
      iterations: NUM_ITERATIONS,
      totalWallTimeMs: creationTotal,
      avgWallTimeMs: creationTotal / NUM_ITERATIONS,
      totalCpuUserMs: creationCpuUser,
      totalCpuSystemMs: creationCpuSystem,
      avgCpuUserMs: creationCpuUser / NUM_ITERATIONS,
      avgCpuSystemMs: creationCpuSystem / NUM_ITERATIONS,
      perIterationTimes: creationTimes,
    },
    subsequentMessages: {
      name: 'Subsequent Messages (same session)',
      iterations: NUM_ITERATIONS,
      totalWallTimeMs: subsequentTotal,
      avgWallTimeMs: subsequentTotal / NUM_ITERATIONS,
      totalCpuUserMs: subsequentCpuUser,
      totalCpuSystemMs: subsequentCpuSystem,
      avgCpuUserMs: subsequentCpuUser / NUM_ITERATIONS,
      avgCpuSystemMs: subsequentCpuSystem / NUM_ITERATIONS,
      perIterationTimes: subsequentTimes,
    },
  }
}

async function main() {
  console.log('Claude Agent SDK Benchmark (Pure SDK)')
  console.log('=====================================')
  console.log(`Iterations per test: ${NUM_ITERATIONS}`)
  console.log(`Prompt: "${PROMPT}"`)
  console.log('')

  // Warmup - load SDK and establish connection
  console.log('Warming up SDK...')
  await unstable_v2_prompt('Say hi', { model: 'claude-sonnet-4-5-20250929' })
  console.log('Warmup complete.\n')

  // Run benchmarks
  console.log('Running benchmarks...\n')

  const results: BenchmarkResult[] = []

  console.log('1/3: SDK one-shot mode (new prompt each time)...')
  results.push(await benchmarkSdkOneShot())

  console.log('2/3: SDK session mode (single session, multiple messages)...')
  results.push(await benchmarkSdkSession())

  console.log('3/3: Comparing new session per message vs subsequent messages...')
  const { sessionCreation, subsequentMessages } =
    await benchmarkSdkSessionWithCreationTime()
  results.push(sessionCreation)
  results.push(subsequentMessages)

  console.log('\n--- RESULTS ---')
  for (const result of results) {
    console.log(formatResult(result))
  }

  // Summary comparison
  const sdkOneShot = results.find((r) => r.name.includes('One-Shot'))!
  const sdkSession = results.find((r) =>
    r.name.includes('createSession + send/receive')
  )!
  const newSessionPerMsg = results.find((r) =>
    r.name.includes('New Session Per Message')
  )!
  const subsequentMsgs = results.find((r) =>
    r.name.includes('Subsequent Messages')
  )!

  console.log('--- COMPARISON ---')
  console.log(
    `One-shot vs Session mode: ${(sdkOneShot.avgWallTimeMs / sdkSession.avgWallTimeMs).toFixed(2)}x`
  )
  console.log(
    `New session per msg vs Subsequent msgs: ${(newSessionPerMsg.avgWallTimeMs / subsequentMsgs.avgWallTimeMs).toFixed(2)}x`
  )
  console.log(
    `\nSession creation overhead: ${(newSessionPerMsg.avgWallTimeMs - subsequentMsgs.avgWallTimeMs).toFixed(0)}ms per message`
  )
  console.log(
    `CPU overhead (user): ${(newSessionPerMsg.avgCpuUserMs - subsequentMsgs.avgCpuUserMs).toFixed(0)}ms per message`
  )
}

main().catch(console.error)
