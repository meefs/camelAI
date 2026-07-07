import type { WorkspaceFileStoreLike } from "./workspace-filesystem-do";

export const SUPPORTED_SHADCN_COMPONENTS = ["accordion", "progress", "tabs"] as const;

export type SupportedShadcnComponent = typeof SUPPORTED_SHADCN_COMPONENTS[number];

export interface AddShadcnComponentsResult {
  success: true;
  components: SupportedShadcnComponent[];
  filesWritten: string[];
  filesSkipped: string[];
  supportedComponents: readonly SupportedShadcnComponent[];
  message: string;
}

interface ShadcnComponentFile {
  path: string;
  content: string;
}

const SHADCN_COMPONENT_FILES: Record<SupportedShadcnComponent, ShadcnComponentFile> = {
  accordion: {
    path: "/app/components/ui/accordion.tsx",
    content: `import * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";

function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
`,
  },
  progress: {
    path: "/app/components/ui/progress.tsx",
    content: `import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "~/lib/utils";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("bg-primary/20 relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-all"
        style={{ transform: \`translateX(-\${100 - (value || 0)}%)\` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
`,
  },
  tabs: {
    path: "/app/components/ui/tabs.tsx",
    content: `import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "~/lib/utils";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]", className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
`,
  },
};

export function normalizeShadcnComponentName(value: unknown): SupportedShadcnComponent {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^@shadcn\//, "");
  if ((SUPPORTED_SHADCN_COMPONENTS as readonly string[]).includes(normalized)) {
    return normalized as SupportedShadcnComponent;
  }
  throw new Error(
    `Unsupported shadcn component "${String(value ?? "")}". Supported components: ${SUPPORTED_SHADCN_COMPONENTS.join(", ")}`,
  );
}

export function normalizeShadcnComponentList(input: {
  component?: unknown;
  components?: unknown;
}): SupportedShadcnComponent[] {
  const rawComponents = input.components !== undefined
    ? Array.isArray(input.components) ? input.components : [input.components]
    : input.component !== undefined
      ? [input.component]
      : [];
  const normalized = rawComponents.map(normalizeShadcnComponentName);
  return [...new Set(normalized)];
}

export async function addShadcnComponentsToProject(
  files: WorkspaceFileStoreLike,
  components: SupportedShadcnComponent[],
  options: { force?: boolean } = {},
): Promise<AddShadcnComponentsResult> {
  if (components.length === 0) {
    throw new Error(`component or components is required. Supported components: ${SUPPORTED_SHADCN_COMPONENTS.join(", ")}`);
  }

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];
  for (const component of components) {
    const file = SHADCN_COMPONENT_FILES[component];
    if (!options.force) {
      const exists = await files.exists(file.path);
      if (exists.exists) {
        filesSkipped.push(file.path);
        continue;
      }
    }
    const result = await files.writeFile(file.path, file.content);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to write ${file.path}`);
    }
    filesWritten.push(file.path);
  }

  return {
    success: true,
    components,
    filesWritten,
    filesSkipped,
    supportedComponents: SUPPORTED_SHADCN_COMPONENTS,
    message: filesWritten.length > 0
      ? `Added shadcn component file${filesWritten.length === 1 ? "" : "s"}: ${filesWritten.join(", ")}`
      : "All requested shadcn component files already exist.",
  };
}
