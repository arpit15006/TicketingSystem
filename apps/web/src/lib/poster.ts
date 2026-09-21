/**
 * Events carry no image and no category — the schema is deliberately narrow (PRD
 * §2). A listing still needs a visual identity per card, so one is derived from
 * the title: a category by keyword, and a gradient that is stable for the same
 * event across renders and devices.
 */

export type Category = "music" | "comedy" | "sports" | "theatre" | "festival" | "other"

const RULES: [Category, RegExp][] = [
  ["sports", /\bvs\b|ipl|cricket|football|match|stadium|derby|kings|indians/i],
  ["comedy", /comedy|stand-?up|tathastu|laugh|roast/i],
  ["theatre", /theatre|theater|hamlet|play\b|drama|ncpa|prithvi|musical/i],
  ["festival", /sunburn|festival|fest\b|arena ft|edm|rave/i],
  ["music", /concert|live|tour|singh|coldplay|band|orchestra|music|spheres|gig/i],
]

export function categoryOf(title: string): Category {
  for (const [category, pattern] of RULES) if (pattern.test(title)) return category
  return "other"
}

export const CATEGORY_LABEL: Record<Category, string> = {
  music: "Music",
  comedy: "Comedy",
  sports: "Sports",
  theatre: "Theatre",
  festival: "Festivals",
  other: "Events",
}

const GRADIENTS: Record<Category, string[]> = {
  music: [
    "from-fuchsia-600 via-purple-700 to-indigo-900",
    "from-rose-500 via-pink-600 to-purple-800",
    "from-violet-600 via-indigo-700 to-slate-900",
  ],
  comedy: [
    "from-amber-400 via-orange-500 to-rose-600",
    "from-yellow-400 via-amber-500 to-orange-700",
  ],
  sports: [
    "from-sky-500 via-blue-700 to-indigo-900",
    "from-emerald-500 via-teal-600 to-cyan-800",
    "from-blue-600 via-indigo-700 to-violet-900",
  ],
  theatre: [
    "from-red-700 via-rose-800 to-stone-900",
    "from-stone-600 via-neutral-800 to-black",
  ],
  festival: [
    "from-lime-400 via-emerald-500 to-teal-700",
    "from-orange-500 via-red-500 to-fuchsia-700",
  ],
  other: ["from-slate-500 via-slate-700 to-slate-900"],
}

function hash(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Tailwind gradient classes for a category you already know, picked
 * deterministically from `seed`.
 *
 * Callers that hold a Category must use this rather than round-tripping through
 * `posterGradient(x, category)`: the keyword rules match event *titles*, and
 * several category names do not match their own rule — `categoryOf("sports")`
 * is "other", so a sports tile would render the grey fallback.
 */
export function categoryGradient(category: Category, seed: string): string {
  const options = GRADIENTS[category]
  return `bg-gradient-to-br ${options[hash(seed) % options.length]}`
}

/** Tailwind gradient classes, chosen deterministically from the event id. */
export function posterGradient(eventId: string, title: string): string {
  return categoryGradient(categoryOf(title), eventId)
}

/** Two initials for the poster monogram — "Arijit Singh" → "AS". */
export function monogram(title: string): string {
  const words = title
    .replace(/[—–:]/g, " ")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(the|a|an|of|vs|ft|in|at|live)$/i.test(w))
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}
