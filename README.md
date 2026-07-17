# t-b.es

A small, owner-managed URL shortener for `t-b.es`. GitHub Pages serves the link desk, while one Cloudflare Worker resolves wildcard short links and handles GitHub App authentication.

## What it does

- `https://g.t-b.es/` resolves at the Cloudflare edge from the redirect map in `hello.txt`.
- `https://t-b.es/` shows a public, read-only directory and lets changes be staged locally.
- `https://auth.t-b.es/` signs the repository owner in with a repository-scoped GitHub App.
- Publishing updates only `main/hello.txt`, with a SHA check to prevent overwriting newer changes.

Redirects use temporary `302` responses with `Cache-Control: no-store`. The Worker caches the source map at the edge for 60 seconds, so a published link normally updates within about a minute.

## Architecture

| Part | Host | Responsibility |
| --- | --- | --- |
| GitHub Pages | `t-b.es` | Static link desk and branded fallback page |
| Cloudflare Worker | `*.t-b.es/*` | Short-link lookup and redirects |
| Cloudflare Worker | `auth.t-b.es` | GitHub OAuth, encrypted session, and Contents API proxy |
| GitHub | `main/hello.txt` | Redirect source of truth |

The browser never receives a GitHub access token. Access and refresh tokens live only inside an encrypted, HTTP-only cookie scoped to `auth.t-b.es`. The link desk receives basic account details and a temporary CSRF token. Staged redirect drafts may be kept in `sessionStorage` so they survive the OAuth round trip; the map is already public, and no credential is stored there.

## Link desk UI system

The frontend intentionally has no framework or build step. Its small design system lives in `assets/styles.css` and includes:

- shared colour, spacing, type, radius, and elevation tokens;
- reusable card, button, form, badge, notice, and list-row components;
- light and dark colour schemes;
- responsive desktop, tablet, and phone layouts; and
- reduced-motion and keyboard-focus support.

Pure redirect parsing and draft-diff logic is isolated in `assets/redirects.js` and covered by Node tests. `assets/app.js` contains the DOM and API controller.

## Redirect rules

`hello.txt` is a JSON object whose keys become subdomains:

```json
{
  "g": "https://google.com/",
  "example": "https://example.com/"
}
```

Names must:

- contain 1–63 lowercase letters, numbers, or hyphens;
- start and end with a letter or number; and
- not be `auth` or `www`, which are reserved by the service.

Destinations must be complete HTTP or HTTPS URLs and may contain at most 2,048 characters. The map is capped at 500 redirects and 64 KiB.

## Local checks

Node.js 22 or newer is required.

```bash
npm install
npm run check

cd worker
npm install
npm run check
npm run check:deploy
```

The root check validates local asset references, duplicate HTML IDs, fallback-page JavaScript, `CNAME`, the redirect map, and frontend unit tests. The Worker check runs syntax and route tests. `check:deploy` asks Wrangler to build and validate the Cloudflare bundle without deploying it.

To preview the static site locally:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. Authentication calls still target production `auth.t-b.es`, whose origin policy accepts only `https://t-b.es`, so sign-in and publishing are deliberately unavailable from the local preview.

## GitHub App setup

Create a GitHub App under **Settings → Developer settings → GitHub Apps** with these settings:

| Setting | Value |
| --- | --- |
| Homepage URL | `https://t-b.es/` |
| Callback URL | `https://auth.t-b.es/auth/callback` |
| Webhook | Disabled |
| Repository permissions → Contents | Read and write |
| Account permissions | None |
| Installation | Only this account, only `to3b/tobesURLshortener` |

Keep user-to-server token expiration enabled. The Worker refreshes expiring user access tokens and restricts the token exchange to repository ID `1061521737`. It also checks that the authenticated login is `to3b` before allowing access.

## Cloudflare deployment

The Worker configuration is in `worker/wrangler.jsonc`. It declares the public routes and the names of the three required secrets, but never their values.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npm run check
npm run check:deploy
npm run deploy
```

`SESSION_SECRET` must contain at least 32 characters. Local development values belong in `worker/.dev.vars`, using `.dev.vars.example` as a template. `.dev.vars*`, `.env*`, build output, and Wrangler state are ignored by Git.

Run `npm run types` after changing Worker bindings or declared secrets.

### Routes and DNS

Wrangler deploys:

- an exact custom domain for `auth.t-b.es`; and
- the `*.t-b.es/*` route for short links.

Cloudflare DNS must retain:

- the apex records used by GitHub Pages;
- a proxied wildcard `*` record so short-link hosts reach Cloudflare; and
- the Worker-managed `auth.t-b.es` custom-domain record.

Do not keep a separate Cloudflare Redirect Rule that rewrites wildcard subdomains to `t-b.es/<name>`; it can create loops and stale permanent redirects.

## Production smoke test

After deployment:

1. Open `https://auth.t-b.es/health` and confirm it returns `{"ok":true}`.
2. Run `curl -I https://g.t-b.es/` and confirm a `302` response with the expected `Location`.
3. Open `https://t-b.es/`, sign in, and stage a harmless change.
4. Publish it and confirm the resulting commit changes only `hello.txt`.
5. Undo the harmless change and publish again if it was only a test.

## Repository layout

```text
.
├── assets/
│   ├── app.js              # Link desk controller
│   ├── redirects.js        # Shared validation and draft-diff logic
│   └── styles.css          # UI tokens and components
├── test/
│   └── redirects.test.js   # Frontend unit tests
├── worker/
│   ├── src/
│   │   ├── entry.js        # Host router
│   │   ├── index.js        # Auth and GitHub API handler
│   │   └── short-redirects.js
│   ├── test/worker.test.mjs
│   └── wrangler.jsonc
├── 404.html                # Self-contained static fallback
├── hello.txt               # Redirect map
└── index.html              # Link desk document
```
