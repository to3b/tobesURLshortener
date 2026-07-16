# t-b.es URL shortener

A deliberately small custom redirect service for `t-b.es`, hosted as a static GitHub Pages site.

## How it works

1. A request such as `g.t-b.es` reaches this GitHub Pages site.
2. GitHub Pages serves `404.html` for the requested subdomain.
3. `redirect.js` reads the subdomain key and loads the redirect map from `hello.txt` on the same origin.
4. Valid HTTP or HTTPS destinations are opened with `location.replace()`.

The data file keeps its existing `hello.txt` name for compatibility with the current setup.

## Add or update a redirect

Edit `hello.txt` and add a JSON entry:

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

## Files

- `hello.txt` — redirect key-to-URL map.
- `redirect.js` — hostname parsing, map loading, URL validation, and redirect logic.
- `404.html` — redirect status and error page.
- `index.html` — minimal landing page for the root domain.
- `robots.txt` — asks search engines not to index the redirect service.
- `.nojekyll` — serves the repository as plain static files.

## Domain setup

GitHub Pages must be configured for `t-b.es`. DNS also needs the apex records required by GitHub Pages and a wildcard record for `*.t-b.es` pointing at the same Pages site.

Domain and DNS settings are intentionally not stored in this update, so the repository does not overwrite the existing live configuration.
