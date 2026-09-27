import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { LoginForm } from "./login-form"

/**
 * The form reads `?next=` with `useSearchParams`, which forces a client-side
 * bailout. Keeping the boundary here means the page still prerenders its shell
 * instead of the whole route opting out of static generation.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  )
}

/**
 * Shaped like what replaces it — heading, two fields, submit, then the demo
 * rows — so the column does not resize under the reader when it arrives.
 */
function LoginSkeleton() {
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}
