import { cn } from "@/lib/utils"

interface SettingsHeaderProps {
  title: string
  description?: string
  className?: string
}

export function SettingsHeader({
  title,
  description,
  className,
}: SettingsHeaderProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
