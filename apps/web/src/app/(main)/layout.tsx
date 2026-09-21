import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"

export default function MainLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      {/*
        No `animate-in` here. It is a transform-based animation, and an element
        with a transform becomes the containing block for its `position: fixed`
        descendants — which silently moved the seat page's action bar to the
        bottom of <main> instead of the bottom of the viewport, 13px off screen.
        A page-transition fade is not worth breaking every fixed overlay under it.
      */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <SiteFooter />
    </>
  )
}
