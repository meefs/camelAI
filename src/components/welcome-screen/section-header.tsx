'use client';

import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';

interface SectionHeaderProps {
  title: string;
  linkText?: string;
  linkHref?: string;
}

export function SectionHeader({ title, linkText = 'View all', linkHref }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {linkHref ? (
        <Link
          to={linkHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <span>{linkText}</span>
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
