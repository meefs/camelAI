import { Link, useSearchParams } from 'react-router';
import type { Route } from './+types/dev.chat-credit-states';
import { BillingCreditNotice, ChatErrorNotice } from '@/components/Chat';
import { getDevBillingCreditStatus, getDevChatInitialError } from '@/lib/chat-credit-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type PreviewState = 'low' | 'low-byok' | 'exhausted' | 'send-error';

const PREVIEW_STATES: Array<{ value: PreviewState; label: string }> = [
  { value: 'low', label: 'Low credits' },
  { value: 'low-byok', label: 'Low + BYOK' },
  { value: 'exhausted', label: 'No credits' },
  { value: 'send-error', label: 'Send failure' },
];

function parseState(value: string | null): PreviewState {
  return PREVIEW_STATES.some((state) => state.value === value) ? (value as PreviewState) : 'low';
}

function stateToSearch(state: PreviewState): string {
  const params = new URLSearchParams();
  params.set('state', state);
  if (state === 'send-error') {
    params.set('devCreditState', 'exhausted');
    params.set('devChatError', 'out-of-credits');
  } else {
    params.set('devCreditState', state);
  }
  return params.toString();
}

export async function loader({ request }: Route.LoaderArgs) {
  void request;
  if (!import.meta.env.DEV) {
    throw new Response('Not found', { status: 404 });
  }
  return null;
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Chat credit state preview - camelAI' }];
}

export default function DevChatCreditStatesRoute() {
  const [searchParams] = useSearchParams();
  const state = parseState(searchParams.get('state'));
  const effectiveSearchParams = new URLSearchParams(stateToSearch(state));
  const creditStatus = getDevBillingCreditStatus(effectiveSearchParams);
  const error = getDevChatInitialError(effectiveSearchParams);

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 border-b pb-5 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Local preview</Badge>
            <Badge>{state}</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Chat credit states</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Preview the chat low-credit banner and the inline error shown after a hosted-model message is rejected for
            exhausted credits.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/chat?devCreditTest=1&devCreditState=low">Open real chat test</Link>
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

        {creditStatus ? (
          <BillingCreditNotice
            status={creditStatus}
            onOpenBilling={() => undefined}
            onOpenProviderSettings={() => undefined}
          />
        ) : null}

        <div className="mx-auto flex min-h-[28rem] w-full max-w-3xl flex-col px-4 py-6 md:px-6">
          <div className="mb-5 self-end rounded-3xl bg-primary px-4 py-3 text-sm text-primary-foreground">
            Can you update the landing page copy?
          </div>
          {error ? <ChatErrorNotice error={error} /> : null}
          {!error ? (
            <div className="mt-auto text-center text-sm text-muted-foreground">
              Send a hosted-model message in this state to see the runtime result.
            </div>
          ) : null}
        </div>

        <div className="border-t p-4">
          <div className="mx-auto flex max-w-3xl items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <span>Message camelAI</span>
            <Button size="sm" disabled>
              Send
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
