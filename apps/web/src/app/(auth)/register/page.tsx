"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CheckIcon, EyeIcon, EyeOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { register as registerUser, useRefreshSession } from "@/lib/auth"
import { registerSchema, type RegisterValues } from "@/lib/schemas"
import { DemoAccounts } from "../demo-accounts"
import { cn } from "cn"

const MIN_PASSWORD = 12

export default function RegisterPage() {
  const router = useRouter()
  const refreshSession = useRefreshSession()
  const [failure, setFailure] = React.useState<ApiError | null>(null)
  const [revealed, setRevealed] = React.useState(false)

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", email: "", password: "" },
  })

  // `useWatch` rather than `form.watch`: the latter hands back a function the
  // React Compiler cannot memoize, so it bails out of optimising this whole
  // component for the sake of one character count.
  const password = useWatch({ control: form.control, name: "password" })
  const longEnough = password.length >= MIN_PASSWORD

  const onSubmit = async (values: RegisterValues): Promise<void> => {
    setFailure(null)
    try {
      await registerUser(values)
      refreshSession()
      router.replace("/")
    } catch (error) {
      if (error instanceof ApiError) {
        // The one field-level failure worth showing in place rather than as a
        // banner: the user can fix it without leaving the input.
        if (error.code === "EMAIL_ALREADY_REGISTERED") {
          form.setError("email", { message: "That email is already registered" })
          return
        }
        setFailure(error)
        return
      }
      throw error
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Create an account</h1>
        <p className="text-sm text-muted-foreground">You need one before you can hold a seat.</p>
      </header>

      {failure !== null && (
        <Alert variant="destructive">
          <AlertTitle>{failure.message}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs">{failure.requestId}</span>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="fullName">Full name</FieldLabel>
            <Input size="lg" id="fullName" autoComplete="name" {...form.register("fullName")} />
            <FieldError errors={[form.formState.errors.fullName]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input size="lg" id="email" type="email" autoComplete="email" {...form.register("email")} />
            <FieldError errors={[form.formState.errors.email]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <div className="relative">
              <Input
                size="lg"
                id="password"
                type={revealed ? "text" : "password"}
                autoComplete="new-password"
                className="pr-10"
                aria-describedby="password-rule"
                {...form.register("password")}
              />
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                aria-label={revealed ? "Hide password" : "Show password"}
                aria-pressed={revealed}
                className="press absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {revealed ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </button>
            </div>
            {/*
              The rule is stated up front and then confirms itself as it is met,
              rather than waiting for submit to say no — the requirement is
              known, so failing it should never be a surprise.
            */}
            <p
              id="password-rule"
              className={cn(
                "flex items-center gap-1.5 text-xs transition-colors",
                longEnough ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
              )}
            >
              <CheckIcon className={cn("size-3.5 transition-opacity", longEnough ? "opacity-100" : "opacity-40")} />
              At least {MIN_PASSWORD} characters
              {!longEnough && password.length > 0 && ` — ${MIN_PASSWORD - password.length} to go`}
            </p>
            <FieldError errors={[form.formState.errors.password]} />
          </Field>
        </FieldGroup>

        <Button type="submit" size="lg" className="w-full font-semibold" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />}
          Create account
        </Button>
      </form>

      <DemoAccounts />

      <p className="text-center text-sm text-muted-foreground">
        Already have one?{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  )
}
