import { SiteHeader } from "@/components/site-header"

export default function MainLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t py-6">
        <p className="mx-auto w-full max-w-6xl px-4 text-sm text-muted-foreground">
          A seat is never sold twice.
        </p>
      </footer>
    </>
  )
}
