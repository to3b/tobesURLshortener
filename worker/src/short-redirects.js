const REDIRECT_KEY_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESERVED_HOSTS = new Set(["auth", "www"]);
const REDIRECT_MAP_CACHE_SECONDS = 60;
const MAX_REDIRECT_MAP_BYTES = 64 * 1024;
const MAX_REDIRECTS = 500;
const MAX_DESTINATION_LENGTH = 2048;

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
    console.error({
      event: "redirect_map_load_failed",
      cause: error instanceof Error ? error.name : "UnknownError",
    });
    return textResponse("Redirect service temporarily unavailable.\n", 502);
  }

  if (!Object.prototype.hasOwnProperty.call(redirects, key)) {
    const rootHost = normaliseHostname(new URL(env.FRONTEND_ORIGIN).hostname);
    return textResponse(`No redirect is configured for ${key}.${rootHost}.\n`, 404);
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
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
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

  const text = await readLimitedText(response, MAX_REDIRECT_MAP_BYTES);
  let redirects;
  try {
    redirects = JSON.parse(text);
  } catch {
    throw new Error("Redirect map must be valid JSON");
  }
  if (!redirects || Array.isArray(redirects) || typeof redirects !== "object") {
    throw new Error("Redirect map must be a JSON object");
  }
  if (Object.keys(redirects).length > MAX_REDIRECTS) {
    throw new Error(`Redirect map may contain at most ${MAX_REDIRECTS} entries`);
  }
  return redirects;
}

function normaliseDestination(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_DESTINATION_LENGTH
  ) {
    return null;
  }
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
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
      ...extraHeaders,
    },
  });
}

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Redirect map is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Redirect map is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
