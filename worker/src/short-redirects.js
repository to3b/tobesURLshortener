const REDIRECT_KEY_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESERVED_HOSTS = new Set(["auth", "www"]);
const REDIRECT_MAP_CACHE_SECONDS = 60;

export function shortRedirectKey(hostname, env) {
  const host = normaliseHostname(hostname);
  const rootHost = normaliseHostname(new URL(env.FRONTEND_ORIGIN).hostname);
  const authHost = normaliseHostname(new URL(env.AUTH_ORIGIN).hostname);

  if (!host || host === rootHost || host === authHost || host === `www.${rootHost}`) {
    return null;
  }

  const suffix = `.${rootHost}`;
  if (!host.endsWith(suffix)) return null;

  const key = host.slice(0, -suffix.length);
  if (!REDIRECT_KEY_PATTERN.test(key) || RESERVED_HOSTS.has(key)) return null;
  return key;
}

export async function handleShortRedirect(request, env, key) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method not allowed.\n", 405, { Allow: "GET, HEAD" });
  }

  let redirects;
  try {
    redirects = await loadRedirectMap(env);
  } catch (error) {
    console.error("Unable to load redirect map:", error);
    return textResponse("Redirect service temporarily unavailable.\n", 502);
  }

  if (!Object.prototype.hasOwnProperty.call(redirects, key)) {
    return textResponse(`No redirect is configured for ${key}.t-b.es.\n`, 404);
  }

  const destination = normaliseDestination(redirects[key]);
  if (!destination) {
    return textResponse("The configured redirect destination is invalid.\n", 502);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.href,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function loadRedirectMap(env) {
  const filePath = String(env.GITHUB_FILE)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const source = `https://raw.githubusercontent.com/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/${encodeURIComponent(env.GITHUB_BRANCH)}/${filePath}`;
  const response = await fetch(source, {
    headers: { Accept: "application/json, text/plain;q=0.9" },
    cf: {
      cacheEverything: true,
      cacheTtl: REDIRECT_MAP_CACHE_SECONDS,
    },
  });

  if (!response.ok) {
    throw new Error(`Redirect map returned HTTP ${response.status}`);
  }

  const redirects = await response.json();
  if (!redirects || Array.isArray(redirects) || typeof redirects !== "object") {
    throw new Error("Redirect map must be a JSON object");
  }
  return redirects;
}

function normaliseDestination(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const destination = new URL(value.trim());
    return destination.protocol === "http:" || destination.protocol === "https:"
      ? destination
      : null;
  } catch {
    return null;
  }
}

function normaliseHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      ...extraHeaders,
    },
  });
}
