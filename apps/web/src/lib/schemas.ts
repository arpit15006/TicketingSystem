import { z } from "zod"

/**
 * Client-side validation mirrors the server's TypeBox schemas exactly
 * (apps/identity/src/server.ts). It is a convenience, not a control: the server
 * validates every request regardless, and a mismatch here would only mean the
 * user learns about a rejection one round trip later.
 */
export const emailSchema = z.email("Enter a valid email address").max(320)

/** Identity requires 12 characters minimum. */
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200, "That is too long")

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password"),
})

export const registerSchema = z.object({
  fullName: z.string().min(1, "Tell us your name").max(200),
  email: emailSchema,
  password: passwordSchema,
})

export type LoginValues = z.infer<typeof loginSchema>
export type RegisterValues = z.infer<typeof registerSchema>
