/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  // Add your Durable Object bindings here:
  // MY_DO: DurableObjectNamespace<MyDurableObject>;
}
