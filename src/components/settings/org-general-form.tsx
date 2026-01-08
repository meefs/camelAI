"use client"

import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { updateOrgName } from "@/lib/server-actions/org"
import { useAuth } from "@/contexts/AuthContext"
import type { Organization } from "@/types"

const orgSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100),
})

type OrgFormValues = z.infer<typeof orgSchema>

interface OrgGeneralFormProps {
  org: Organization
  canEdit: boolean
}

export function OrgGeneralForm({ org, canEdit }: OrgGeneralFormProps) {
  const { refreshAuth } = useAuth()
  const [saving, setSaving] = useState(false)

  const defaultValues = useMemo(
    () => ({
      name: org.name,
    }),
    [org.name]
  )

  const form = useForm<OrgFormValues>({
    resolver: zodResolver(orgSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  const onSubmit = async (values: OrgFormValues) => {
    if (!canEdit) return
    setSaving(true)
    try {
      await updateOrgName(org.id, values.name.trim())
      toast.success("Organization updated")
      await refreshAuth()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update organization"
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization name</FormLabel>
                <FormControl>
                  <Input {...field} disabled={!canEdit} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {canEdit ? (
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          ) : null}
        </form>
      </Form>
    </div>
  )
}
