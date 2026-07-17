# t-b.es URL shortener

A deliberately small redirect service for `t-b.es`, hosted on GitHub Pages. Wildcard subdomains redirect from the JSON map in `hello.txt`; the apex page provides a terminal-inspired redirect manager.

## How redirects work

1. A request such as `g.t-b.es` reaches this GitHub Pages site.
2. GitHub Pages serves `404.html` for the requested wildcard subdomain.
3. The redirect logic runs directly inside `404.html`, so it does not request JavaScript or other local assets from that subdomain.
4. The page loads the redirect map from the repository's raw `main/hello.txt` file.
5. Valid HTTP or HTTPS destinations are opened with `location.replace()`.

The redirect logic is intentionally self-contained. On wildcard GitHub Pages hosts, requests such as `/redirect.js` may also receive `404.html`, so relying on subdomain-relative assets can cause recursive or invalid asset responses.

## Redirect manager

The root `https://t-b.es/` page can:

- load and filter the current redirects;
- stage additions, updates, and removals locally;
- validate subdomain names and HTTP/HTTPS destinations;
- detect if `hello.txt` changed before publishing; and
- commit the updated JSON directly to `main/hello.txt`.

Reading redirects remains public. Publishing uses **Sign in with GitHub** through a repository-scoped GitHub App and a small Cloudflare Worker at `https://auth.t-b.es`.

The browser never receives a GitHub access token. The Worker stores GitHub's user access token and refresh token inside an encrypted, HTTP-only cookie scoped to `auth.t-b.es`. The frontend receives only basic account information and a temporary CSRF token. GitHub user access tokens are refreshed automatically when they approach expiration.

## One-time authentication setup

The repository contains all application code, but GitHub App registration, secrets, and DNS cannot be created from a public repository. Complete these steps once after merging the authentication PR.

### 1. Create the GitHub App

Open GitHub **Settings → Developer settings → GitHub Apps → New GitHub App** and use:

| Setting | Value |
| --- | --- |
| GitHub App name | `t-b.es Redirect Manager` or another unique name |
| Homepage URL | `https://t-b.es/` |
| Callback URL | `https://auth.t-b.es/auth/callback` |
| Webhook | Disable **Active**; no webhook is used |
| Repository permissions → Contents | **Read and write** |
| Account permissions | None |
| Where can this GitHub App be installed? | **Only on this account** |

Keep **user-to-server token expiration** enabled. It is normally enabled by default and allows the Worker to rotate short-lived access tokens using refresh tokens.

After creating the app:

1. Copy its **Client ID**.
2. Generate and copy one **Client secret**.
3. Select **Install App**.
4. Install it only on `to3b/tobesURLshortener`.

The OAuth request is additionally restricted to repository ID `1061521737`, and the Worker permits only the GitHub login `to3b`.

### 2. Deploy the authentication Worker

The Worker source is under `worker/`.

```bash
cd worker
npm install
npx wrangler login
```

Add the required encrypted secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Then deploy:

```bash
npm run check
npm run deploy
```

Cloudflare stores Worker secrets separately from the repository. Do not put the client secret or session secret in `wrangler.toml`, `.dev.vars.example`, GitHub commits, or Pages files.

### 3. Attach `auth.t-b.es`

In Cloudflare **Workers & Pages**, open the deployed `tbes-redirect-auth` Worker and add this custom domain:

```text
auth.t-b.es
```

`auth.t-b.es` must resolve to the Worker rather than the wildcard GitHub Pages record. Using a same-site subdomain is important because the login session is an HTTP-only cookie and should not depend on third-party cookie access.

The Worker configuration expects:

```text
FRONTEND_ORIGIN=https://t-b.es
AUTH_ORIGIN=https://auth.t-b.es
```

### 4. Verify the flow

1. Open `https://auth.t-b.es/health` and confirm it returns `{"ok":true}`.
2. Open `https://t-b.es/`.
3. Select **Sign in with GitHub**.
4. Authorize the app as `to3b`.
5. Stage a harmless redirect change and publish it.
6. Confirm the commit changed only `hello.txt`.

After the first authorization, the browser remains signed in until the refresh token expires, the cookie is cleared, or the GitHub authorization is revoked. On another device, use **Sign in with GitHub**; no personal access token needs to be located or copied.

## Local Worker development

Copy the example environment file and fill in development credentials:

```bash
cd worker
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

`.dev.vars` is ignored by Git and must never be committed.

## Manual editing

`hello.txt` remains the source of truth and can still be edited directly:

```json
{
  "g": "https://google.com",
  "example": "https://example.com"
}
```

The key becomes the subdomain. For example, `example` is available at `example.t-b.es` after GitHub Pages deploys the change.

Keep the file as valid JSON:

- Use double quotes around keys and URLs.
- Separate entries with commas.
- Do not add a comma after the final entry.
- Use a complete `http://` or `https://` destination.
- Do not use `auth`; `auth.t-b.es` is reserved for the authentication Worker.

## Files

- `hello.txt` — redirect key-to-URL map.
- `404.html` — self-contained redirect logic, status display, and error handling.
- `index.html` — self-contained redirect management frontend.
- `worker/src/index.js` — GitHub App OAuth, encrypted sessions, token refresh, validation, and GitHub Contents API proxy.
- `worker/wrangler.toml` — non-secret Worker configuration.
- `worker/test/worker.test.mjs` — validation and parsing tests.
- `robots.txt` — asks search engines not to index the redirect service.
- `.nojekyll` — serves the repository as plain static files.
- `CNAME` — binds GitHub Pages to `t-b.es`.

## Domain setup

GitHub Pages must be configured for `t-b.es`. DNS needs the apex records required by GitHub Pages and a wildcard record for `*.t-b.es` pointing at the Pages site. The explicit `auth.t-b.es` hostname must point to the authentication Worker and take precedence over the wildcard record.
