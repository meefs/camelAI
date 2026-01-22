import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

const themes = [
  { value: "system", label: "Auto detect", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const

export function ThemePreference() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Avoid hydration mismatch by only rendering after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <div className="space-y-2">
        <Label>Appearance</Label>
        <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
        <p className="text-xs text-muted-foreground">
          Choose your preferred color scheme.
        </p>
      </div>
    )
  }

  const currentTheme = themes.find((t) => t.value === theme) ?? themes[0]

  return (
    <div className="space-y-2">
      <Label>Appearance</Label>
      <div className="flex items-center gap-3">
        <Tabs value={theme} onValueChange={setTheme}>
          <TabsList>
            {themes.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} title={label}>
                <Icon className="size-4" />
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-sm text-muted-foreground">
          {currentTheme.label}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose your preferred color scheme.
      </p>
    </div>
  )
}
