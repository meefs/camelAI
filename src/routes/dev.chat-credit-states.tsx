import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Route } from './+types/dev.chat-credit-states';
import { BillingCreditNotice, ChatErrorNotice } from '@/components/Chat';
import { TopUpDialog } from '@/components/billing/top-up-dialog';
import { ContentBlockRenderer } from '@/components/message-bubble';
import { getDevBillingCreditStatus, getDevChatInitialError } from '@/lib/chat-credit-status';
import { getChatApiErrorPresentation } from '@/lib/chat-api-errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LlmProvider } from '@/types';

type PreviewState =
  | 'healthy'
  | 'low-500'
  | 'low-250'
  | 'low-100'
  | 'low-50'
  | 'exhausted'
  | 'exhausted-byok'
  | 'send-error'
  | 'byok-anthropic-429'
  | 'byok-openrouter-429'
  | 'byok-openai-429'
  | 'byok-bedrock-429'
  | 'hosted-429'
  | 'generic-error';

const ANTHROPIC_2B_RATE_LIMIT =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';
const GENERIC_ERROR = 'The sandbox stopped responding while preparing the turn.';

const PREVIEW_STATES: Array<{ value: PreviewState; label: string }> = [
  { value: 'healthy', label: 'Healthy' },
  { value: 'low-500', label: '4.50 credits left' },
  { value: 'low-250', label: '2.20 credits left' },
  { value: 'low-100', label: '0.80 credits left' },
  { value: 'low-50', label: '0.45 credits left' },
  { value: 'exhausted', label: 'No credits' },
  { value: 'exhausted-byok', label: 'No credits + BYOK' },
  { value: 'send-error', label: 'Send failure' },
  { value: 'byok-anthropic-429', label: 'Anthropic 429' },
  { value: 'byok-openrouter-429', label: 'OpenRouter 429' },
  { value: 'byok-openai-429', label: 'OpenAI 429' },
  { value: 'byok-bedrock-429', label: 'Bedrock 429' },
  { value: 'hosted-429', label: 'Hosted 429' },
  { value: 'generic-error', label: 'Generic error' },
];

function parseState(value: string | null): PreviewState {
  return PREVIEW_STATES.some((state) => state.value === value) ? (value as PreviewState) : 'low-500';
}

function stateToSearch(state: PreviewState): string {
  const params = new URLSearchParams();
  params.set('state', state);
  if (state === 'send-error') {
    params.set('devCreditState', 'exhausted');
    params.set('devChatError', 'out-of-credits');
  } else if (
    state === 'healthy' ||
    state === 'low-500' ||
    state === 'low-250' ||
    state === 'low-100' ||
    state === 'low-50' ||
    state === 'exhausted' ||
    state === 'exhausted-byok'
  ) {
    params.set('devCreditState', state);
  }
  return params.toString();
}

function errorContextForState(state: PreviewState): {
  rawError: string;
  llmProvider: LlmProvider | null;
  billingSource?: 'byok' | 'hosted';
} | null {
  if (state === 'byok-anthropic-429') {
    return {
      rawError: ANTHROPIC_2B_RATE_LIMIT,
      llmProvider: 'anthropic',
      billingSource: 'byok',
    };
  }
  if (state === 'byok-openrouter-429') {
    return {
      rawError: ANTHROPIC_2B_RATE_LIMIT,
      llmProvider: 'openrouter',
      billingSource: 'byok',
    };
  }
  if (state === 'byok-openai-429') {
    return {
      rawError: ANTHROPIC_2B_RATE_LIMIT,
      llmProvider: 'openai',
      billingSource: 'byok',
    };
  }
  if (state === 'byok-bedrock-429') {
    return {
      rawError: ANTHROPIC_2B_RATE_LIMIT,
      llmProvider: 'bedrock',
      billingSource: 'byok',
    };
  }
  if (state === 'hosted-429') {
    return {
      rawError: ANTHROPIC_2B_RATE_LIMIT,
      llmProvider: 'openai',
      billingSource: 'hosted',
    };
  }
  if (state === 'generic-error') {
    return {
      rawError: GENERIC_ERROR,
      llmProvider: null,
    };
  }
  return null;
}

export async function loader({ request }: Route.LoaderArgs) {
  void request;
  if (!import.meta.env.DEV) {
    throw new Response('Not found', { status: 404 });
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  void (await request.formData());
  if (!import.meta.env.DEV) {
    throw new Response('Not found', { status: 404 });
  }
  return null;
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Chat error state preview - camelAI' }];
}

export default function DevChatCreditStatesRoute() {
  const [searchParams] = useSearchParams();
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [loadingPreviewOpen, setLoadingPreviewOpen] = useState(false);
  const state = parseState(searchParams.get('state'));
  const effectiveSearchParams = new URLSearchParams(stateToSearch(state));
  const creditStatus = getDevBillingCreditStatus(effectiveSearchParams);
  const errorContext = errorContextForState(state);
  const devInitialError = getDevChatInitialError(effectiveSearchParams);
  const error = errorContext
    ? getChatApiErrorPresentation(errorContext.rawError, {
        billingSource: errorContext.billingSource,
        llmProvider: errorContext.llmProvider,
      })
    : devInitialError
      ? getChatApiErrorPresentation(devInitialError)
      : null;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 border-b pb-5 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Local preview</Badge>
            <Badge>{state}</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Chat error states</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Preview the chat low-credit banner, provider rate-limit messaging, and generic inline error surfaces.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/chat?devCreditTest=1&devCreditState=low-500">Open real chat test</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>State</CardTitle>
          <CardDescription>These controls do not call Stripe or mutate billing state.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {PREVIEW_STATES.map((previewState) => (
            <Button key={previewState.value} asChild variant={previewState.value === state ? 'default' : 'outline'}>
              <Link to={`/dev/chat-credit-states?${stateToSearch(previewState.value)}`}>{previewState.label}</Link>
            </Button>
          ))}
        </CardContent>
      </Card>

      <section className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">m&apos;s Workspace</p>
          <p className="text-xs text-muted-foreground">Chat preview with billing state injected</p>
        </div>

        <div className="mx-auto flex min-h-[28rem] w-full max-w-3xl flex-col px-4 py-6 md:px-6">
          <div className="mb-5 self-end rounded-3xl bg-primary px-4 py-3 text-sm text-primary-foreground">
            Can you update the landing page copy?
          </div>
          {errorContext ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Transcript error block
              </p>
              <ContentBlockRenderer
                content={[
                  {
                    type: 'error',
                    title: 'Assistant error',
                    error: errorContext.rawError,
                  },
                ]}
                llmProvider={errorContext.llmProvider}
              />
            </div>
          ) : null}
        </div>

        <div className="border-t p-4">
          <div className="mx-auto w-full max-w-3xl space-y-2">
            {error ? <ChatErrorNotice error={error} /> : null}
            {creditStatus ? (
              <BillingCreditNotice
                status={creditStatus}
                onOpenUsage={() => undefined}
                onTopUp={() => setTopUpOpen(true)}
                userId="dev-user"
                orgId="dev-org"
              />
            ) : null}
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <span>Message camelAI</span>
              <Button size="sm" disabled>
                Send
              </Button>
            </div>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Top-up modal</CardTitle>
          <CardDescription>
            Opens the in-chat top-up picker with mocked pack data.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setTopUpOpen(true)}>
            Open packs
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLoadingPreviewOpen(true)}
          >
            Open loading
          </Button>
        </CardContent>
      </Card>
      <TopUpDialog
        open={topUpOpen}
        onOpenChange={setTopUpOpen}
        packs={[
          { id: 'price_mock_500', creditsLabel: '5.00 credits', priceLabel: '$5.00' },
          { id: 'price_mock_2500', creditsLabel: '25.00 credits', priceLabel: '$25.00' },
        ]}
        canTopUp
        returnTo="/chat/dev-preview"
      />
      <TopUpDialog
        open={loadingPreviewOpen}
        onOpenChange={setLoadingPreviewOpen}
        packs={[]}
        loading
        canTopUp
        returnTo="/chat/dev-preview"
      />
    </main>
  );
}
