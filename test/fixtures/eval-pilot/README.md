# Eval pilot fixture

A synthetic Webflow-style site used by `wcag eval pilot` (Phase 1, D0) to prove
the offline transport boundary at HEAD and at the baseline. Served by
`src/eval/pilot/fixture-server.ts`; `{{SITE}}` and `{{CDN}}` are replaced with
the server's origins at request time.

- `home.html`: images sent to the alt-text prompt (local and CDN-hosted), Webflow
  tabs without roles, a modal, a GET search form, a service worker registration.
- `contact.html`: client-side validation errors, a newsletter form that submits
  by `fetch` and `XMLHttpRequest`, and a native POST form. Submitting the contact
  form paints random pixels into a canvas, so a post-submission screenshot taken
  in replay never equals the captured one (the DOM and text are unchanged).
- `about.html`: heading, table and landmark structure issues.
- `trap.html`: requests that cannot be in the HAR (random URLs), a WebSocket, a
  dynamically inserted CDN image and a telemetry beacon. Used to show that misses
  and egress are detected; never part of the clean pilot page set.

Nothing here is real site content.
