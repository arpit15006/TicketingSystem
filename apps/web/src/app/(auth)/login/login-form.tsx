"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { login, useRefreshSession } from "@/lib/auth"
import { loginSchema, type LoginValues } from "@/lib/schemas"

export function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const refreshSession = useRefreshSession()
  const [failure, setFailure] = React.useState<ApiError | null>(null)

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  const onSubmit = async (values: LoginValues): Promise<void> => {
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
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account you booked with.</CardDescription>
      </CardHeader>

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <CardContent>
          {failure !== null && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>{failure.message}</AlertTitle>
              <AlertDescription>
                {/* PRD §14 — the id is the handle an operator greps. */}
                <span className="font-mono text-xs">{failure.requestId}</span>
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...form.register("email")}
              />
              <FieldError errors={[form.formState.errors.email]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...form.register("password")}
              />
              <FieldError errors={[form.formState.errors.password]} />
            </Field>
          </FieldGroup>
        </CardContent>

        <CardFooter className="mt-6 flex-col gap-4">
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Sign in
          </Button>
          <p className="text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/register" className="underline underline-offset-4">
              Create one
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
