"use client";

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

interface AdminSearchProps {
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export function AdminSearch({
  placeholder = 'Search',
  className,
  inputClassName,
}: AdminSearchProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const currentSearch = searchParams.get('search') ?? '';
  const [query, setQuery] = useState(currentSearch);

  useEffect(() => {
    setQuery(currentSearch);
  }, [currentSearch]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === currentSearch.trim()) return;

    const timeout = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (trimmed) {
        params.set('search', trimmed);
      } else {
        params.delete('search');
      }
      params.delete('offset');
      const queryString = params.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname);
    }, 300);

    return () => clearTimeout(timeout);
  }, [query, currentSearch, pathname, router, searchParams]);

  return (
    <InputGroup className={cn("h-8", className)}>
      <InputGroupAddon>
        <Search className="h-3.5 w-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn("h-8 text-sm", inputClassName)}
      />
    </InputGroup>
  );
}
