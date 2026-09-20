"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { pickUpNewGrants } from "@/lib/auth"
import type { Venue } from "@/lib/api-types"

const schema = z.object({
  name: z.string().min(1, "Name the venue").max(200),
  address: z.string().min(1, "Add an address").max(300),
  city: z.string().min(1, "Which city?").max(100),
})
type Values = z.infer<typeof schema>

export function CreateVenueDialog({ onCreated, children }: { onCreated: (venue: Venue) => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "", address: "", city: "" } })

  const submit = async (values: Values): Promise<void> => {
    try {
      const venue = await api<Venue>("/catalog/venues", { method: "POST", body: values })
      // Creation just granted venue_admin:venue:<id>; the token must carry it
      // before sections can be laid out in this venue.
      await pickUpNewGrants()
      toast.success(`${venue.name} added`)
      onCreated(venue)
      form.reset()
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not create the venue")
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <form onSubmit={form.handleSubmit(submit)} noValidate>
          <DialogHeader>
            <DialogTitle>New venue</DialogTitle>
            <DialogDescription>You become its administrator, so you can lay out its seatmap.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-6">
            <Field>
              <FieldLabel htmlFor="venue-name">Name</FieldLabel>
              <Input id="venue-name" placeholder="Wankhede Stadium" {...form.register("name")} />
              <FieldError errors={[form.formState.errors.name]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="venue-address">Address</FieldLabel>
              <Input id="venue-address" placeholder="D Road, Churchgate" {...form.register("address")} />
              <FieldError errors={[form.formState.errors.address]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="venue-city">City</FieldLabel>
              <Input id="venue-city" placeholder="Mumbai" {...form.register("city")} />
              <FieldError errors={[form.formState.errors.city]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create venue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
