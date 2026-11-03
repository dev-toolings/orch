# Design

Tableau Kiba. Clone in place of the Flux AgentOps console (measured 2026-11-01 on https://flux-agentops.reui.io). Luma tokens, Frame inset shell. No vendor bundle copied.

## Scene

Kevin reads orch on kev. The shell is a 260px transparent sidebar plus an inset main frame (8px margin, 18px radius, 1px border). Cards sit one step lighter than the page.

## Tokens

Measured computed values, named in `ui/src/index.css`:

- Dark: background `#070707` (lab 2.75), card/sidebar surface `#141414` (lab 7.78), muted `#262626` (lab 15.2), foreground `#fafafa` (lab 98.26), muted-foreground `#a3a3a3` (lab 66.1), border `rgb(255 255 255 / 0.1)`.
- Light: background/card `#ffffff`, foreground `#070707`, muted `#f4f4f5`, muted-foreground `#737373`, border `rgb(0 0 0 / 0.1)`.
- Radius: 10px (`--radius` 0.625rem), pills ~20px, frame 18px (`rounded-2xl`).
- Type: Inter 400–600, Roboto Mono, self-hosted. Body 16px / 24px.
- Motion: 150ms cubic-bezier(0.4, 0, 0.2, 1) on width/height/padding/background. Live badge: ping 1s linear. Reduced-motion kills both.

## Signature

Frame inset + pill nav. Live ping on the health badge. Atelier 3D stays a secondary route.

## States

Empty: honest (no invented evals, flags, hook asks). Error: API unreachable. Loading: “Lecture de l'instantané…”.

## Provenance

isoclone of Flux AgentOps. Mapping table in `/tmp/isoclone-flux/FINAL.md` after the compare pass.
