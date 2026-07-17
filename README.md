# t-b.es URL shortener

A deliberately small redirect service for `t-b.es`. The apex manager is hosted on GitHub Pages, while a Cloudflare Worker handles both wildcard short links and GitHub App authentication.

## How redirects work

1. A request such as `https://g.t-b.es/` matches the Worker route `*.t-b.es/*`.
2. The Worker extracts the key `g` from the hostname.
3. It loads the JSON redirect map from `main/hello.txt`. The map fetch is cached at the Cloudflare edge for 60 seconds.
4. A valid destination is returned as a temporary HTTP `302` redirect with `Cache-Control: no-store`.
5. Unknown names return a plain `404` response instead of reaching the GitHub Pages origin.

Using the Worker for wildcard hosts avoids relying on unsupported wildcard GitHub Pages custom domains and prevents permanent browser-cached redirect loops.

The repository still contains `404.html` as a static fallback, but production wildcard traffic should be handled by the Worker route.

## Redirect manager

The root `https://t-b.es/` page can:

- load and filter the current redirects;
- stage additions, updates, and removals locally;
- validate subdomain names and HTTP/HTTPS destinations;
- detect if `hello.txt` changed before publishing; and
- commit the updated JSON directly to `main/hello.txt`.

Reading redirects remains public. Publishing uses **Sign in with GitHub** through a repository-scoped GitHub App and the same Cloudflare Worker at `https://auth.t-b.es`.

The browser never receives a GitHub access token. The Worker stores GitHub's user access token and refresh token inside an encrypted, HTTP-only cookie scoped to `auth.t-b.es`. The frontend receives only basic account information and a temporary CSRF token. GitHub user access tokens are refreshed automatically when they approach expiration.

## One-time GitHub App setup

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

The access-token request is additionally restricted to repository ID `1061521737`, and the Worker permits only the GitHub login `to3b`.

## Deploy the Worker

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

On Windows Command Prompt, paste hidden secret prompts with right-click or **Shift+Insert** rather than `Ctrl+V`.

Then deploy:

```bash
npm run check
npm run deploy
```

Cloudflare stores Worker secrets separately from the repository. Do not put the client secret or session secret in `wrangler.toml`, `.dev.vars.example`, GitHub commits, or Pages files.

## Cloudflare routes and DNS

`worker/wrangler.toml` deploys two routes:

```toml
[[routes]]
pattern = "auth.t-b.es"
custom_domain = true

[[routes]]
pattern = "*.t-b.es/*"
zone_name = "t-b.es"
```

The exact custom domain keeps authentication on `auth.t-b.es`. The wildcard route intercepts all other subdomains before they reach the existing origin.

Cloudflare DNS must contain:

- the apex records used by GitHub Pages for `t-b.es`;
- a proxied wildcard `*` record so `*.t-b.es` resolves through Cloudflare; and
- the Worker-managed `auth.t-b.es` custom-domain record.

Disable the old Cloudflare **Redirect Rule** that rewrites wildcard subdomains to `t-b.es/<name>`. It is no longer required and can create loops or cached permanent redirects.

## Verify the deployment

1. Open `https://auth.t-b.es/health` and confirm it returns `{"ok":true}`.
2. Run `curl.exe -I https://g.t-b.es/` and confirm it returns `302` with `Location: https://google.com/`.
3. Open `https://t-b.es/` and select **Sign in with GitHub**.
4. Authorize the app as `to3b`.
5. Stage a harmless redirect change and publish it.
6. Confirm the commit changed only `hello.txt`.

After the first authorization, the browser remains signed in until the refresh token expires, the cookie is cleared, or the GitHub authorization is revoked.

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

The key becomes the subdomain. For example, `example` is available at `example.t-b.es` after the Worker refreshes its cached map, normally within 60 seconds.

Keep the file as valid JSON:

- Use double quotes around keys and URLs.
- Separate entries with commas.
- Do not add a comma after the final entry.
- Use a complete `http://` or `https://` destination.
- Do not use `auth`; `auth.t-b.es` is reserved for the authentication Worker.

## Files

- `hello.txt` — redirect key-to-URL map.
- `index.html` — self-contained redirect management frontend.
- `404.html` — static fallback redirect page.
- `worker/src/entry.js` — hostname router for wildcard links, `www`, and authentication requests.
- `worker/src/short-redirects.js` — wildcard redirect-map loading and HTTP redirect responses.
- `worker/src/index.js` — GitHub App OAuth, encrypted sessions, token refresh, validation, and GitHub Contents API proxy.
- `worker/wrangler.toml` — Worker routes and non-secret configuration.
- `worker/test/worker.test.mjs` — validation, authentication-route, and wildcard-route tests.
- `robots.txt` — asks search engines not to index the redirect service.
- `.nojekyll` — serves the repository as plain static files.
- `CNAME` — binds GitHub Pages to `t-b.es`.
