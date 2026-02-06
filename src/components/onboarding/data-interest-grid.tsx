import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Database, FileJson, FileSpreadsheet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { OnboardingFileType } from '@/types';
import type { IntegrationInterestOption } from '@/lib/onboarding';
import { IntegrationIcon } from '@/lib/integration-icons';
import { cn } from '@/lib/utils';

interface DataInterestGridProps {
  selectedFiles: OnboardingFileType[];
  selectedIntegrations: string[];
  onToggleFile: (file: OnboardingFileType) => void;
  onToggleIntegration: (id: string) => void;
  integrationOptions: IntegrationInterestOption[];
}

const FILE_TYPES: Array<{
  id: OnboardingFileType;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: 'csv', label: 'CSV', icon: FileSpreadsheet },
  { id: 'excel', label: 'Excel', icon: FileSpreadsheet },
  { id: 'sqlite', label: 'SQLite', icon: Database },
  { id: 'json', label: 'JSON', icon: FileJson },
];

const INTEGRATIONS_PER_PAGE = 20;

export function DataInterestGrid({
  selectedFiles,
  selectedIntegrations,
  onToggleFile,
  onToggleIntegration,
  integrationOptions,
}: DataInterestGridProps) {
  const [integrationPage, setIntegrationPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const filteredIntegrations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return integrationOptions;
    return integrationOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        option.id.toLowerCase().includes(query)
    );
  }, [integrationOptions, searchQuery]);

  useEffect(() => {
    setIntegrationPage(0);
  }, [searchQuery]);

  const integrationPageCount = Math.max(
    1,
    Math.ceil(filteredIntegrations.length / INTEGRATIONS_PER_PAGE)
  );
  const page = Math.min(integrationPage, integrationPageCount - 1);
  const pageIntegrationOptions = useMemo(() => {
    const offset = page * INTEGRATIONS_PER_PAGE;
    return filteredIntegrations.slice(offset, offset + INTEGRATIONS_PER_PAGE);
  }, [filteredIntegrations, page]);

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 text-sm font-medium text-muted-foreground">
          Files
          <span className="ml-2 text-xs font-normal">
            (drag and drop into chat)
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FILE_TYPES.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => onToggleFile(id)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors',
                selectedFiles.includes(id)
                  ? 'border-foreground bg-muted'
                  : 'hover:border-foreground/30'
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-sm">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-muted-foreground">
            Connections
            <span className="ml-2 text-xs font-normal">(live API access)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search integrations..."
                className="h-8 w-44 pr-8 text-xs"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute inset-y-0 right-0 inline-flex items-center px-2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {integrationPageCount > 1 ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={page <= 0}
                  onClick={() =>
                    setIntegrationPage((current) => Math.max(0, current - 1))
                  }
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page + 1} / {integrationPageCount}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={page >= integrationPageCount - 1}
                  onClick={() =>
                    setIntegrationPage((current) =>
                      Math.min(integrationPageCount - 1, current + 1)
                    )
                  }
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {filteredIntegrations.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No integrations found.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pageIntegrationOptions.map((option) => (
              <button
                type="button"
                key={option.id}
                onClick={() => onToggleIntegration(option.id)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                  selectedIntegrations.includes(option.id)
                    ? 'border-foreground bg-muted font-medium'
                    : 'hover:border-foreground/30'
                )}
              >
                <IntegrationIcon
                  type={option.id}
                  size={16}
                  className="size-4 shrink-0"
                />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
