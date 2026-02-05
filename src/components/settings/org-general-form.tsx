"use client"

import { useEffect } from "react"
import { Form, useActionData, useNavigation, useRevalidator } from "react-router"
import { useForm, getFormProps, getInputProps, type SubmissionResult } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { orgNameFormSchema } from "@/lib/schemas"
import type { Organization } from "@/types"

interface OrgGeneralFormProps {
  org: Organization
  canEdit: boolean
}

export function OrgGeneralForm({ org, canEdit }: OrgGeneralFormProps) {
  const revalidator = useRevalidator()
  const actionData = useActionData<{ result?: SubmissionResult<string[]>; success?: boolean }>()
  const navigation = useNavigation()
  const saving = navigation.state === "submitting"

  const [form, fields] = useForm({
    lastResult: actionData?.result,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: orgNameFormSchema })
    },
    defaultValue: {
      name: org.name,
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  // Handle success
  useEffect(() => {
    if (actionData?.success && navigation.state === "idle") {
      toast.success("Organization updated")
      revalidator.revalidate()
    }
  }, [actionData?.success, navigation.state, revalidator])

  const nameErrors = fields.name.errors

  return (
    <div className="space-y-6 max-w-2xl">
      <Form method="post" {...getFormProps(form)} className="space-y-6">
        <input type="hidden" name="intent" value="updateOrgName" />

        <div className="space-y-2">
          <Label htmlFor={fields.name.id}>Organization name</Label>
          <Input
            {...getInputProps(fields.name, { type: "text" })}
            disabled={!canEdit}
          />
          {nameErrors && nameErrors.length > 0 && (
            <p className="text-sm text-destructive">{nameErrors[0]}</p>
          )}
        </div>

        {canEdit ? (
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        ) : null}
      </Form>
    </div>
  )
}
