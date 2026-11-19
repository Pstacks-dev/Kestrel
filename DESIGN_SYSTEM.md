# Kestrel Design System

This document translates the supplied **Design Principles & UI/UX Reference** into implementation rules for the Kestrel product. It is the shared reference for future UI changes; it does not replace product or security requirements.

## Direction

Kestrel should feel like a serious engineering product: precise, quiet, information-dense where needed, and easy to operate. Use Linear and Notion as interface references, Stripe for public-page hierarchy, Apple for restrained motion, Duolingo for clear onboarding patterns, Airbnb for search/filter behavior, and Pentagram for typography and art direction.

Avoid generic AI landing-page patterns: no filler badges, decorative metric cards, invented activity, random italics, gratuitous gradients, redundant labels, or decorative flowcharts that do not explain the actual product.

## Design foundations

- Palette: warm neutral surfaces, charcoal text, muted secondary text, a restrained amber accent, and semantic green/red only for real states.
- Typography: readable sans-serif for interface and headings; monospace only for commands, identifiers, timestamps, and logs.
- Shape: use a small, consistent radius scale. Inner corners should remain visually consistent with their containing surfaces.
- Borders: subtle neutral borders instead of heavy shadows. Reserve elevation for overlays and focused dialogs.
- Icons: use one icon family with consistent stroke weight and size.
- Density: group related controls with spacing; avoid excess cards and labels.
- Content: use specific, plain-language headings and explain what an action will do.

## Motion and feedback

- Entrances use a short ease-out; movement between states uses ease-in-out.
- Dropdowns and small overlays should feel immediate (roughly 150–250ms).
- Stagger dense lists only when it improves scanning; keep the delay subtle.
- Press feedback may scale to approximately 0.97–0.985.
- Do not use bounce for routine controls. Never animate while a control is held.
- Success, error, and pending states must be communicated with useful text, not colour alone.
- Respect `prefers-reduced-motion`.

## Product-wide page requirements

| Area | Required treatment |
|---|---|
| Landing | Specific product explanation, real capabilities, clear primary action, no fabricated live metrics |
| Signup / login | Short forms, visible password toggle, clear validation, pending and success states |
| Admin | Separate restricted entry, explicit access-denied state, server-verified privileges |
| Workspace overview | Values from the API only; clear loading, empty, error and refresh states |
| Projects | Search/filter where the data volume warrants it; readable repository details and secret controls |
| Pipelines | Clear job dependencies, explicit trigger action, no pretend executions |
| Runs and logs | Real statuses, timestamps, searchable/copyable logs, clear cancel/retry feedback |
| Artifacts | Real metadata and authenticated download actions |
| Deployments | Clear provider, environment, approval and rollback states |
| Settings | Group configuration by purpose; explain security-sensitive values |

## Responsive behavior

- No horizontal page scrolling at supported widths.
- Text and identifiers wrap or truncate intentionally; never escape their containers.
- Controls have comfortable touch targets and remain reachable on mobile.
- Sidebar becomes a dismissible mobile drawer; overlays remain within the viewport.
- Forms collapse to one column on narrow screens.
- Tables and row actions must remain usable without forcing the entire page wider.
- Loading placeholders reserve their final space to avoid layout shifts.
- Keep network payloads and visual assets modest for slower connections.

## Interaction and accessibility

- Provide visible keyboard focus, semantic buttons/links, labels, and useful accessible names.
- Keep keyboard navigation and Escape-to-dismiss behavior for overlays.
- Support command search with `Ctrl/Cmd + K`.
- Provide searchable/filterable lists when they solve a real navigation problem.
- Use tabular numerals for changing numeric values and align columns consistently.
- Make copy, download, refresh, submit, and destructive actions produce honest feedback.
- Do not show example values as live system data. Use explicit examples only in documentation and label them as examples.

## Reference checklist

Before shipping a page, verify: visual hierarchy; content accuracy; responsive layout; focus states; loading/empty/error/success states; useful micro-interactions; reduced-motion support; no horizontal overflow; and no fake operational data.