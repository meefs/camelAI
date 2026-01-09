/// <reference types="@cloudflare/workers-types" />

interface CloudflareEnv {
  ASSETS: Fetcher;
  // Add your bindings here:
  // MY_DO: DurableObjectNamespace<MyDO>;
  // MY_KV: KVNamespace;
  // MY_R2: R2Bucket;
}
