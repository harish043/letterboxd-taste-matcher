<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

Next.js 16 full-stack app (App Router, Turbopack, Tailwind CSS v4, React 19) located in `src/`.

## React Server Components standard

- **Default to React Server Components (RSC).** Every component is a server component unless it has a concrete reason not to be. Do not add `"use client"` reflexively.
- **`"use client"` is the exception**, used only when a component genuinely needs interactivity: `useState`, `useEffect`, `useReducer`, `useRef`, event handlers, browser-only APIs, or React context providers.
- **Keep client components at the leaf.** Push interactive state as far down the tree as possible. Wrap small interactive pieces (a button, an input) in their own client component rather than making a whole page client-side.
- **Fetch data server-side.** Do data fetching in async server components (or Server Actions / Route Handlers), never in client components or via `useEffect`. Server components can be `async` and `await` data directly.
- **Pass only serializable props** across the server/client boundary. Do not pass functions, class instances, or non-serializable values to client components.
- **Mutations use Server Actions** (`"use server"`), not hand-rolled client-side API calls.
- **Use Next.js primitives** (`<Image>`, `<Link>`, `next/navigation`, `metadata` exports) rather than raw equivalents.
- Layouts and pages are server components by default; they should generally stay server-side and delegate interactivity to child client components.

## Commands

- `npm run dev` — Turbopack dev server
- `npm run build` — production build (run before shipping; catches type/route errors)
- `npm run lint` — ESLint
- `npm start` — serve production build

## Structure

- All application code lives in `src/` (App Router at `src/app/`).
- Imports use the `@/*` alias (maps to `src/*`).
- Tailwind CSS v4 — CSS-first config in `src/app/globals.css`; there is no `tailwind.config` file.
- Do not edit the `<!-- BEGIN:nextjs-agent-rules -->` block above; `next dev` regenerates it.
