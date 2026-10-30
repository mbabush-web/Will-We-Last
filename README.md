# Will We Last — site

Static site for willwelast.app. No build step.

- `public/index.html` — landing page
- `public/calculator.html` — the calculator (served at /calculator)
- `wrangler.jsonc` — Cloudflare Workers static-assets config; Cloudflare runs `npx wrangler deploy` on every push to `main`
