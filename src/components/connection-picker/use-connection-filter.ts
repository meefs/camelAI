'use client';

import { useMemo, useState } from 'react';

export interface FilterableIntegration {
  type: string;
  displayName: string;
  category: string;
}

export const CATEGORY_TAB_LABELS: Record<string, string> = {
  all: 'All',
  databases: 'Data',
  saas: 'SaaS',
  ai_services: 'AI',
  cloud_providers: 'Cloud',
  communication: 'Comms',
};

export function useConnectionFilter(
  integrations: FilterableIntegration[],
  excludeTypes?: string[]
) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  const baseIntegrations = useMemo(() => {
    if (!excludeTypes || excludeTypes.length === 0) return integrations;
    return integrations.filter((i) => !excludeTypes.includes(i.type));
  }, [integrations, excludeTypes]);

  const categories = useMemo(() => {
    const cats = new Set(baseIntegrations.map((i) => i.category));
    return ['all', ...Array.from(cats)];
  }, [baseIntegrations]);

  const filteredIntegrations = useMemo(() => {
    let result = baseIntegrations;

    if (activeCategory !== 'all') {
      result = result.filter((i) => i.category === activeCategory);
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(
        (i) =>
          i.displayName.toLowerCase().includes(query) ||
          i.type.toLowerCase().includes(query)
      );
    }

    return result;
  }, [baseIntegrations, activeCategory, searchQuery]);

  return {
    searchQuery,
    setSearchQuery,
    activeCategory,
    setActiveCategory,
    filteredIntegrations,
    categories,
  };
}
