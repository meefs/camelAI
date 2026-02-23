"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { type SubmissionResult, getFormProps, getTextareaProps, useForm } from "@conform-to/react"
import { parseWithZod } from "@conform-to/zod/v4"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  HELP_CATEGORY_LABELS,
  HELP_CATEGORY_VALUES,
  HELP_DESCRIPTION_MAX_LENGTH,
  HELP_SEVERITY_LABELS,
  HELP_SEVERITY_VALUES,
  type HelpCategory,
  type HelpSeverity,
  getHelpFormSchema,
} from "@/lib/help"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"

interface GetHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultCategory?: HelpCategory
}

function severityDotClass(severity: HelpSeverity): string {
  if (severity === "high") return "bg-destructive"
  if (severity === "medium") return "bg-yellow-500"
  return "bg-green-500"
}

function readPageContext(): { pageUrl: string; screenSize: string } {
  if (typeof window === "undefined") {
    return { pageUrl: "", screenSize: "" }
  }
  return {
    pageUrl: window.location.href,
    screenSize: `${window.innerWidth}x${window.innerHeight}`,
  }
}

export function GetHelpDialog({ open, onOpenChange, defaultCategory }: GetHelpDialogProps) {
  const isMobile = useIsMobile()
  const fetcher = useFetcher<{
    result?: SubmissionResult<string[]>;
    success?: boolean;
    error?: string;
  }>()
  const saving = fetcher.state !== "idle"

  const [category, setCategory] = useState<HelpCategory>("bug")
  const [severity, setSeverity] = useState<HelpSeverity>("low")
  const [description, setDescription] = useState("")
  const [pageUrl, setPageUrl] = useState("")
  const [screenSize, setScreenSize] = useState("")
  const [formSessionId, setFormSessionId] = useState(0)
  const [lastSubmissionResult, setLastSubmissionResult] = useState<SubmissionResult<string[]> | undefined>(undefined)
  const hasOpenedRef = useRef(false)
  const successToastShownRef = useRef(false)

  const [form, fields] = useForm({
    id: `get-help-form-${formSessionId}`,
    lastResult: lastSubmissionResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: getHelpFormSchema })
    },
    defaultValue: {
      category: "bug",
      severity: "low",
      description: "",
      pageUrl: "",
      screenSize: "",
    },
    shouldValidate: "onBlur",
    shouldRevalidate: "onInput",
  })

  const descriptionProps = useMemo(() => {
    const { defaultValue: _defaultValue, ...props } = getTextareaProps(fields.description)
    return props
  }, [fields.description])

  useEffect(() => {
    if (!open) return
    successToastShownRef.current = false
    if (hasOpenedRef.current) {
      setFormSessionId((current) => current + 1)
    } else {
      hasOpenedRef.current = true
    }
    setLastSubmissionResult(undefined)
    const context = readPageContext()
    setCategory(defaultCategory ?? "bug")
    setSeverity("low")
    setDescription("")
    setPageUrl(context.pageUrl)
    setScreenSize(context.screenSize)
  }, [open])

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return
    setLastSubmissionResult(fetcher.data.success ? undefined : fetcher.data.result)
    if (fetcher.data.success && !successToastShownRef.current) {
      successToastShownRef.current = true
      toast.success("Help request sent! Check your email for confirmation.")
      onOpenChange(false)
      return
    }
    if (fetcher.data.error) {
      toast.error(fetcher.data.error)
    }
  }, [fetcher.state, fetcher.data, onOpenChange])

  const categoryOptions = useMemo(
    () =>
      HELP_CATEGORY_VALUES.map((value) => ({
        value,
        label: HELP_CATEGORY_LABELS[value],
      })),
    []
  )

  const severityOptions = useMemo(
    () =>
      HELP_SEVERITY_VALUES.map((value) => ({
        value,
        label: HELP_SEVERITY_LABELS[value],
      })),
    []
  )

  const submitDisabled = saving || description.trim().length === 0
  const descriptionHelpTextId = `${fields.description.id}-help-text`
  const descriptionDescribedBy = fields.description.errors?.length
    ? `${descriptionHelpTextId} ${fields.description.errorId}`
    : descriptionHelpTextId

  const formContent = (
    <fetcher.Form
      action="/api/help"
      method="post"
      {...getFormProps(form)}
      className="space-y-4"
    >
      <input type="hidden" name={fields.category.name} value={category} />
      <input type="hidden" name={fields.severity.name} value={severity} />
      <input type="hidden" name={fields.pageUrl.name} value={pageUrl} />
      <input type="hidden" name={fields.screenSize.name} value={screenSize} />

      <div className="space-y-2">
        <Label htmlFor={fields.category.id}>Category</Label>
        <Select value={category} onValueChange={(value) => setCategory(value as HelpCategory)}>
          <SelectTrigger id={fields.category.id} aria-invalid={fields.category.errors?.length ? true : undefined} className="w-full">
            <SelectValue placeholder="Select a category" />
          </SelectTrigger>
          <SelectContent>
            {categoryOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fields.category.errors && fields.category.errors.length > 0 ? (
          <p className="text-sm text-destructive">{fields.category.errors[0]}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={fields.severity.id}>Severity</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={severity}
          onValueChange={(value) => {
            if (!value) return
            setSeverity(value as HelpSeverity)
          }}
          className="w-full flex-wrap"
          aria-label="Severity"
        >
          {severityOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              id={option.value === "low" ? fields.severity.id : undefined}
              className="min-w-[96px] justify-center"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${severityDotClass(option.value)}`}
                aria-hidden
              />
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {fields.severity.errors && fields.severity.errors.length > 0 ? (
          <p className="text-sm text-destructive">{fields.severity.errors[0]}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={fields.description.id}>Description</Label>
        <Textarea
          {...descriptionProps}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What happened? What did you expect? Include steps to reproduce if applicable."
          maxLength={HELP_DESCRIPTION_MAX_LENGTH}
          className="min-h-[120px] max-h-[240px]"
          aria-describedby={descriptionDescribedBy}
          aria-invalid={fields.description.errors?.length ? true : undefined}
        />
        <p id={descriptionHelpTextId} className="text-xs text-muted-foreground">
          The more detail you include, the faster we can help.
        </p>
        {fields.description.errors && fields.description.errors.length > 0 ? (
          <p id={fields.description.errorId} className="text-sm text-destructive">
            {fields.description.errors[0]}
          </p>
        ) : null}
      </div>
    </fetcher.Form>
  )

  const submitLabel = saving ? (
    <span className="inline-flex items-center gap-1.5">
      <Loader2 className="size-3.5 animate-spin" />
      Sending...
    </span>
  ) : (
    "Submit"
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>Get Help</SheetTitle>
            <SheetDescription>
              Tell us what you need help with. We&apos;ll get back to you via email.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 pb-2">{formContent}</div>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={form.id} disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Get Help</DialogTitle>
          <DialogDescription>
            Tell us what you need help with. We&apos;ll get back to you via email.
          </DialogDescription>
        </DialogHeader>
        {formContent}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={form.id} disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
