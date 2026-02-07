import { useMemo, type ComponentType } from 'react';
import { Database, FileJson, FileSpreadsheet } from 'lucide-react';
import type { OnboardingFileType } from '@/types';
import type { IntegrationInterestOption } from '@/lib/onboarding';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';
import { ConnectionPicker } from '@/components/connection-picker';
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

export function DataInterestGrid({
  selectedFiles,
  selectedIntegrations,
  onToggleFile,
  onToggleIntegration,
  integrationOptions,
}: DataInterestGridProps) {
  const pickerIntegrations = useMemo(
    () =>
      integrationOptions.map((opt) => ({
        type: opt.id,
        displayName: opt.label,
        category: INTEGRATION_REGISTRY[opt.id]?.category ?? 'saas',
      })),
    [integrationOptions]
  );

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
        <div className="mb-3 text-sm font-medium text-muted-foreground">
          Connections
          <span className="ml-2 text-xs font-normal">(live API access)</span>
        </div>
        <ConnectionPicker
          integrations={pickerIntegrations}
          mode="multi-select"
          variant="compact"
          maxHeight="280px"
          selectedIds={selectedIntegrations}
          onToggle={onToggleIntegration}
          excludeTypes={['other']}
          searchPlaceholder="Search integrations..."
        />
      </section>
    </div>
  );
}
