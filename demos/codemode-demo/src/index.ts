import { generateText, stepCountIs, tool } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { z } from "zod";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

interface Env {
  LOADER: WorkerLoader;
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_NAME: string;
  CF_GATEWAY_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const myTools = {
  add: tool({
    description: "Add two numbers together",
    parameters: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    execute: async ({ a, b }) => a + b,
  }),
  multiply: tool({
    description: "Multiply two numbers",
    parameters: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    execute: async ({ a, b }) => a * b,
  }),
  subtract: tool({
    description: "Subtract b from a",
    parameters: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    execute: async ({ a, b }) => a - b,
  }),
  formatCurrency: tool({
    description: "Format a number as currency",
    parameters: z.object({ amount: z.number(), currency: z.string() }),
    outputSchema: z.string(),
    execute: async ({ amount, currency }) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount),
  }),
};


// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({
        usage: 'POST { "prompt": "add 5 and 3, multiply by 10, format as EUR" }',
      });
    }

    const { prompt } = await request.json<{ prompt: string }>();

    // CF AI Gateway with dynamic/auto model routing
    const gateway = createAiGateway({
      accountId: env.CF_ACCOUNT_ID,
      gateway: env.CF_GATEWAY_NAME,
      apiKey: env.CF_GATEWAY_TOKEN,
    });
    const unified = createUnified();
    const model = gateway(unified("dynamic/auto_search"));

    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const t0 = performance.now();
    const codeTool = createCodeTool({ tools: myTools, executor });
    console.log(`[bench] createCodeTool (generateTypes): ${(performance.now() - t0).toFixed(1)}ms`);

    try {
    const { text, steps, finishReason, response } = await generateText({
      model,
      tools: { codemode: codeTool },
      stopWhen: stepCountIs(10),
      prompt,
      onStepFinish: ({ stepNumber, finishReason, toolCalls, toolResults }) => {
        console.log(`[step ${stepNumber}] finishReason=${finishReason} toolCalls=${toolCalls.length} toolResults=${toolResults.length}`);
      },
    });

    console.log(`[done] steps=${steps.length} finishReason=${finishReason} text=${text.slice(0,100)}`);
    return Response.json({ text, finishReason, numSteps: steps.length, steps });
    } catch (err: any) {
      console.error(`[error]`, err);
      return Response.json({ error: err.message, cause: String(err.cause ?? ''), name: err.name }, { status: 500 });
    }
  },
};
