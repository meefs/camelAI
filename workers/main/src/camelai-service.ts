import { WorkerEntrypoint } from "cloudflare:workers";
import {
  executeVirtualAiRun,
  type AIVirtualBindingEnv,
  type AIVirtualBindingProps,
} from "./ai-virtual-binding.js";
import {
  generateImage,
  type GenerateImageOptions,
  type GenerateImageResult,
} from "./generate-image.js";

export type CamelAiServiceProps = AIVirtualBindingProps;

/**
 * Virtual service binding for camelAI helpers (image generation).
 *
 * User workers bind `CAMELAI` as a service; cf-api-proxy rewrites the starter
 * `LocalCamelAiService` entrypoint to this class with workspace/org props.
 */
export class CamelAiService extends WorkerEntrypoint<
  AIVirtualBindingEnv,
  CamelAiServiceProps
> {
  async generateImage(
    input: string | GenerateImageOptions,
  ): Promise<GenerateImageResult> {
    return generateImage(
      {
        run: (model, runInput) =>
          executeVirtualAiRun(
            {
              env: this.env,
              props: this.ctx.props,
              waitUntil: (promise) => this.ctx.waitUntil(promise),
            },
            model,
            runInput,
          ),
      },
      input,
    );
  }
}
