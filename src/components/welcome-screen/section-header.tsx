'use client';

import { ArrowRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

interface SectionHeaderProps {
  title: string;
  linkText?: string;
  linkHref?: string;
  onRefresh?: () => void;
}

export function SectionHeader({ title, linkText = 'View all', linkHref, onRefresh }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="flex items-center gap-2">
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            className={cn(
              'inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer',
              'transition-colors duration-150'
            )}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span>Shuffle</span>
          </button>
        ) : null}
        {linkHref ? (
          <Link
            to={linkHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <span>{linkText}</span>
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
