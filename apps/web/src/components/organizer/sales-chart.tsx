"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

const config = {
  sold: { label: "Sold", color: "var(--chart-1)" },
  held: { label: "Held", color: "var(--chart-2)" },
  available: { label: "Available", color: "var(--chart-3)" },
} satisfies ChartConfig

export interface SalesPoint {
  name: string
  sold: number
  held: number
  available: number
}

export function SalesChart({ data }: { data: SalesPoint[] }) {
  return (
    <ChartContainer config={config} className="h-64 w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 8 }}>
        <CartesianGrid horizontal={false} />
        <YAxis dataKey="name" type="category" width={140} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
        <XAxis type="number" hide />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="sold" stackId="a" fill="var(--color-sold)" radius={[4, 0, 0, 4]} />
        <Bar dataKey="held" stackId="a" fill="var(--color-held)" />
        <Bar dataKey="available" stackId="a" fill="var(--color-available)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  )
}
