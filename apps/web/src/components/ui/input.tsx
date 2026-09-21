import * as React from "react"
import { cn } from "cn"

/**
 * `size="lg"` (36px) for forms that are the page's whole purpose — signing in,
 * registering — where the default 32px reads as dense-data compact. It is the
 * same height as Button's `lg`, so a field and its submit line up.
 */
function Input({
  className,
  type,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "lg" | undefined }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        size === "lg" ? "h-9" : "h-8",
        "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
