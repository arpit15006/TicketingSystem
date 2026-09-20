"use client"

import Link from "next/link"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { KeyRoundIcon, ShieldCheckIcon, UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { storeTokens } from "@/lib/tokens"
import { passwordSchema } from "@/lib/schemas"
import type { TokenPair } from "@/lib/api-types"

const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "Passwords do not match" })
type Values = z.infer<typeof schema>

export default function AccountPage() {
  const { user, isAuthenticated, isLoading } = useSession()
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { currentPassword: "", newPassword: "", confirm: "" } })

  const submit = async (values: Values): Promise<void> => {
    try {
      // Every other session is revoked by this call; the pair it returns keeps
      // this one signed in.
      const pair = await api<TokenPair>("/identity/auth/change-password", {
        method: "POST",
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      })
      storeTokens(pair)
      form.reset()
      toast.success("Password changed", { description: "Other devices have been signed out." })
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
        form.setError("currentPassword", { message: "That is not your current password" })
        return
      }
      toast.error(error instanceof ApiError ? error.message : "Could not change the password")
    }
  }

  if (!isLoading && !isAuthenticated) {
    return (
      <Alert className="mx-auto max-w-md">
        <AlertTitle>Sign in to manage your account</AlertTitle>
        <AlertDescription>
          <Button size="sm" className="mt-2" asChild>
            <Link href="/login?next=/account">Sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <UserIcon className="size-6" />
          Account
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="grid grid-cols-[120px_1fr] gap-2">
            <span className="text-muted-foreground">Name</span>
            <span>{user?.fullName ?? "…"}</span>
            <span className="text-muted-foreground">Email</span>
            <span>{user?.email ?? "…"}</span>
            <span className="text-muted-foreground">Roles</span>
            <span className="flex flex-wrap gap-1">
              {(user?.roles ?? []).map((g, i) => (
                <Badge key={i} variant="secondary" className="font-mono text-[10px]">
                  {g.role}
                  {g.resourceType !== null && `:${g.resourceType}`}
                </Badge>
              ))}
            </span>
          </div>
          <Separator />
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheckIcon className="size-4 shrink-0" />
            Roles are granted per resource — an organizer role names the events it covers. Every service checks the
            grant itself; nothing here can be edited into a permission.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            Change password
          </CardTitle>
          <CardDescription>Signs out every other device. This one stays signed in.</CardDescription>
        </CardHeader>
        <form onSubmit={form.handleSubmit(submit)} noValidate>
          <CardContent className="flex flex-col gap-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="current">Current password</FieldLabel>
                <Input id="current" type="password" autoComplete="current-password" {...form.register("currentPassword")} />
                <FieldError errors={[form.formState.errors.currentPassword]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="new">New password</FieldLabel>
                <Input id="new" type="password" autoComplete="new-password" {...form.register("newPassword")} />
                <FieldDescription>At least 12 characters.</FieldDescription>
                <FieldError errors={[form.formState.errors.newPassword]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
                <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
                <FieldError errors={[form.formState.errors.confirm]} />
              </Field>
            </FieldGroup>
            <Button type="submit" className="w-fit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Change password
            </Button>
          </CardContent>
        </form>
      </Card>
    </div>
  )
}
