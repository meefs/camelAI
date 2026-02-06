import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { Check, Loader2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const STRICT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;
const PARTIAL_SLUG_PATTERN = /^[a-z0-9-]+$/;

interface SlugCheckResult {
  available?: boolean;
  reason?: 'invalid_format' | 'taken' | 'not_owner';
}

export type SlugAvailabilityState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'taken'
  | 'invalid'
  | 'too_short';

interface SlugInputProps {
  orgId: string;
  currentSlug: string;
  value: string;
  vanityDomain: string;
  onChange: (value: string) => void;
  onAvailabilityChange?: (state: SlugAvailabilityState) => void;
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function getClientStatus(slug: string): SlugAvailabilityState {
  if (!slug) return 'idle';
  if (slug.length < 3) return 'too_short';
  if (slug.length > 24) return 'invalid';
  if (!PARTIAL_SLUG_PATTERN.test(slug)) return 'invalid';
  if (slug.startsWith('-') || slug.endsWith('-')) return 'invalid';
  return STRICT_SLUG_PATTERN.test(slug) ? 'checking' : 'invalid';
}

function getStatusMessage(status: SlugAvailabilityState): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'checking':
      return 'Checking...';
    case 'taken':
      return 'Already taken';
    case 'too_short':
      return 'At least 3 characters';
    case 'invalid':
      return 'Letters, numbers, and hyphens only';
    default:
      return '';
  }
}

export function SlugInput({
  orgId,
  currentSlug,
  value,
  vanityDomain,
  onChange,
  onAvailabilityChange,
}: SlugInputProps) {
  const fetcher = useFetcher<SlugCheckResult>();
  const [status, setStatus] = useState<SlugAvailabilityState>('idle');
  const requestedSlugRef = useRef<string | null>(null);
  const fetcherSubmitRef = useRef(fetcher.submit);
  const normalizedValue = useMemo(() => normalizeSlug(value), [value]);
  const normalizedCurrentSlug = useMemo(
    () => normalizeSlug(currentSlug),
    [currentSlug]
  );

  useEffect(() => {
    fetcherSubmitRef.current = fetcher.submit;
  }, [fetcher.submit]);

  useEffect(() => {
    onAvailabilityChange?.(status);
  }, [status, onAvailabilityChange]);

  useEffect(() => {
    if (fetcher.state !== 'idle') {
      setStatus('checking');
      return;
    }

    if (!fetcher.data) return;
    if (requestedSlugRef.current !== normalizedValue) return;

    if (fetcher.data.available) {
      setStatus('available');
      return;
    }

    if (fetcher.data.reason === 'taken') {
      setStatus('taken');
      return;
    }

    setStatus('invalid');
  }, [fetcher.state, fetcher.data, normalizedValue]);

  useEffect(() => {
    if (normalizedValue === normalizedCurrentSlug) {
      setStatus('available');
      return;
    }

    const nextClientStatus = getClientStatus(normalizedValue);
    if (nextClientStatus !== 'checking') {
      setStatus(nextClientStatus);
      return;
    }

    setStatus('checking');
    const timer = window.setTimeout(() => {
      requestedSlugRef.current = normalizedValue;
      fetcherSubmitRef.current(JSON.stringify({ slug: normalizedValue }), {
        method: 'post',
        action: `/api/orgs/${orgId}/check-slug`,
        encType: 'application/json',
      });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [normalizedCurrentSlug, normalizedValue, orgId]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <label htmlFor="org-slug" className="text-sm font-medium">
          Organization slug
        </label>
        <div className="flex items-center gap-3">
          <Input
            id="org-slug"
            value={value}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange(normalizeSlug(event.target.value))}
          />
          <div
            className={cn(
              'flex min-w-[130px] items-center justify-end gap-1 text-sm',
              status === 'available' && 'text-emerald-600',
              (status === 'invalid' ||
                status === 'taken' ||
                status === 'too_short') &&
                'text-destructive',
              status === 'checking' && 'text-muted-foreground'
            )}
          >
            {status === 'checking' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            {status === 'available' ? <Check className="h-4 w-4" /> : null}
            {status === 'invalid' ||
            status === 'taken' ||
            status === 'too_short' ? (
              <X className="h-4 w-4" />
            ) : null}
            <span>{getStatusMessage(status)}</span>
          </div>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Your apps will live at{' '}
        <span className="font-medium text-foreground">
          https://my-app--{normalizedValue || 'your-slug'}.{vanityDomain}
        </span>
      </p>

      <p className="text-sm text-muted-foreground">
        This can only be changed now, before your first app is published.
      </p>
    </div>
  );
}
