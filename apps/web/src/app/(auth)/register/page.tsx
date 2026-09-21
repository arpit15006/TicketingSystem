"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { register as registerUser, useRefreshSession } from "@/lib/auth"
import { registerSchema, type RegisterValues } from "@/lib/schemas"

export default function RegisterPage() {
  const router = useRouter()
  const refreshSession = useRefreshSession()
  const [failure, setFailure] = React.useState<ApiError | null>(null)

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", email: "", password: "" },
  })

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
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>You need one before you can hold a seat.</CardDescription>
      </CardHeader>

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <CardContent className="flex flex-col gap-6">
          {failure !== null && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>{failure.message}</AlertTitle>
              <AlertDescription>
                <span className="font-mono text-xs">{failure.requestId}</span>
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="fullName">Full name</FieldLabel>
              <Input size="lg" id="fullName" autoComplete="name" {...form.register("fullName")} />
              <FieldError errors={[form.formState.errors.fullName]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input size="lg"
                id="email"
                type="email"
                autoComplete="email"
                {...form.register("email")}
              />
              <FieldError errors={[form.formState.errors.email]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input size="lg"
                id="password"
                type="password"
                autoComplete="new-password"
                {...form.register("password")}
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
              <FieldError errors={[form.formState.errors.password]} />
            </Field>
          </FieldGroup>
          <Button type="submit" size="lg" className="w-full font-semibold" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Create account
          </Button>
        </CardContent>

        <CardFooter className="mt-6">
          <p className="text-sm text-muted-foreground">
            Already have one?{" "}
            <Link href="/login" className="underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
