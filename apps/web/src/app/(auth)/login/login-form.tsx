"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { login, useRefreshSession, useSession } from "@/lib/auth"
import { loginSchema, type LoginValues } from "@/lib/schemas"
import { DemoAccounts } from "../demo-accounts"

export function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const refreshSession = useRefreshSession()
  const [failure, setFailure] = React.useState<ApiError | null>(null)
  const [revealed, setRevealed] = React.useState(false)

  /*
    Already signed in? There is nothing to do here — unless the session was
    created a moment ago *by this page*, in which case the sign-in already has
    a destination and this redirect would only overwrite it.
  */
  const [signingIn, setSigningIn] = React.useState(false)
  const { isAuthenticated } = useSession()
  React.useEffect(() => {
    if (isAuthenticated && !signingIn) router.replace("/")
  }, [isAuthenticated, signingIn, router])

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  const onSubmit = async (values: LoginValues): Promise<void> => {
    setSigningIn(true)
    setFailure(null)
    try {
      await login(values.email, values.password)
      refreshSession()
      // Only ever a same-site path: an open redirect here would let a phishing
      // link bounce a freshly-authenticated user to an attacker's page.
      const next = params.get("next")
      router.replace(next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/")
    } catch (error) {
      if (error instanceof ApiError) setFailure(error)
      else throw error
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Use the account you booked with.</p>
      </header>

      {failure !== null && (
        <Alert variant="destructive">
          <AlertTitle>{failure.message}</AlertTitle>
          <AlertDescription>
            {/* PRD §14 — the id is the handle an operator greps. */}
            <span className="font-mono text-xs">{failure.requestId}</span>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input size="lg" id="email" type="email" autoComplete="email" {...form.register("email")} />
            <FieldError errors={[form.formState.errors.email]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            {/*
              The reveal toggle sits inside the field rather than beside it, so
              the input keeps the full column width and the control stays where
              the eye already is — at the end of what was just typed.
            */}
            <div className="relative">
              <Input
                size="lg"
                id="password"
                type={revealed ? "text" : "password"}
                autoComplete="current-password"
                className="pr-10"
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
            <FieldError errors={[form.formState.errors.password]} />
          </Field>
        </FieldGroup>

        <Button type="submit" size="lg" className="w-full font-semibold" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />}
          Sign in
        </Button>
      </form>

      <DemoAccounts onStart={() => setSigningIn(true)} />

      <p className="text-center text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
          Create one
        </Link>
      </p>
    </div>
  )
}
