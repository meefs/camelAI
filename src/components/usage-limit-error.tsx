import { Link } from 'react-router';
import { ArrowRight, CirclePause, Lightbulb, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UsageLimitErrorProps {
  spentUSD: string;
  limitUSD: string;
  windowLabel: string;
  onDismiss: () => void;
}

const WINDOW_LABEL_REGEX = /^(\d+(?:\.\d+)?)([hdms])$/;
// This route is org-admin only today; keep the direct link unless team-specific
// messaging becomes necessary for non-admin members.
const AI_PROVIDER_SETTINGS_PATH = '/settings/organization/ai-provider';

function humanizeWindowLabel(windowLabel: string): string {
  const match = windowLabel.match(WINDOW_LABEL_REGEX);
  if (!match) {
    return windowLabel;
  }

  const [, value, unit] = match;
  const unitLabel = {
    h: 'hour',
    d: 'day',
    m: 'minute',
    s: 'second',
  }[unit];

  if (!unitLabel) {
    return windowLabel;
  }

  const numericValue = Number(value);
  const suffix = numericValue === 1 ? '' : 's';
  return `${value} ${unitLabel}${suffix}`;
}

export function UsageLimitError({
  spentUSD,
  limitUSD,
  windowLabel,
  onDismiss,
}: UsageLimitErrorProps) {
  const humanizedWindowLabel = humanizeWindowLabel(windowLabel);

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CirclePause className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            Usage limit reached
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss usage limit message"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-2 space-y-1 text-sm text-muted-foreground">
        <p>
          You&apos;ve used ${spentUSD} of your ${limitUSD} limit in the last{' '}
          {humanizedWindowLabel}.
        </p>
        <p>Your usage will refresh soon. You can continue chatting then.</p>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Bypass limits by adding your own API key</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {'Connect an Anthropic or AWS Bedrock key in Organization Settings \u2192 AI Provider'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild className="shrink-0">
            <Link to={AI_PROVIDER_SETTINGS_PATH}>
              Add key
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
