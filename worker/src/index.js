const SESSION_COOKIE = "tbes_session";
const STATE_COOKIE = "tbes_oauth_state";
const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const MAX_REDIRECTS = 500;
const MAX_DESTINATION_LENGTH = 2048;
const RESERVED_KEYS = new Set(["auth", "www"]);

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      validateEnvironment(env);

      if (request.method === "OPTIONS") {
        return handleOptions(request, env);
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ ok: true }, 200, request, env);
      }

      if (url.pathname === "/auth/login" && request.method === "GET") {
        return startLogin(env);
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return finishLogin(request, env);
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        assertFrontendOrigin(request, env);
        const auth = await requireSession(request, env);
        assertCsrf(request, auth.session);
        return jsonResponse(
          { authenticated: false },
          200,
          request,
          env,
          { "Set-Cookie": clearCookie(SESSION_COOKIE) },
        );
      }

      if (url.pathname === "/api/session" && request.method === "GET") {
        assertFrontendOrigin(request, env);
        const auth = await requireSession(request, env);
        return jsonResponse(
          {
            authenticated: true,
            user: {
              login: auth.session.login,
              name: auth.session.name || auth.session.login,
              avatarUrl: auth.session.avatarUrl || "",
            },
            csrfToken: auth.session.csrfToken,
            accessExpiresAt: auth.session.accessExpiresAt || null,
          },
          200,
          request,
          env,
          auth.setCookie ? { "Set-Cookie": auth.setCookie } : undefined,
        );
      }

      if (url.pathname === "/api/redirects" && request.method === "GET") {
        assertFrontendOrigin(request, env);
        const auth = await requireSession(request, env);
        const file = await githubRequest(env, auth.session.accessToken, filePath(env, true));
        const redirects = parseRedirectFile(file);

        return jsonResponse(
          {
            redirects,
            sha: file.sha,
            branch: env.GITHUB_BRANCH,
            file: env.GITHUB_FILE,
          },
          200,
          request,
          env,
          auth.setCookie ? { "Set-Cookie": auth.setCookie } : undefined,
        );
      }

      if (url.pathname === "/api/redirects" && request.method === "PUT") {
        assertFrontendOrigin(request, env);
        const auth = await requireSession(request, env);
        assertCsrf(request, auth.session);
        const body = await readJsonBody(request);
        const redirects = validateRedirects(body.redirects);
        const expectedSha = requireString(body.sha, "The current file SHA is required.");
        const message = requireString(body.message, "A commit message is required.").slice(0, 72);

        const current = await githubRequest(env, auth.session.accessToken, filePath(env, true));
        if (current.sha !== expectedSha) {
          throw new HttpError(
            409,
            "hello.txt changed on GitHub after this page loaded. Reload before publishing.",
            "sha_conflict",
          );
        }

        const updated = await githubRequest(env, auth.session.accessToken, filePath(env, false), {
          method: "PUT",
          body: JSON.stringify({
            message,
            content: encodeBase64Utf8(serialiseRedirects(redirects)),
            sha: current.sha,
            branch: env.GITHUB_BRANCH,
          }),
        });

        return jsonResponse(
          {
            redirects,
            sha: updated.content.sha,
            commitSha: updated.commit.sha,
          },
          200,
          request,
          env,
          auth.setCookie ? { "Set-Cookie": auth.setCookie } : undefined,
        );
      }

      throw new HttpError(404, "Not found.", "not_found");
    } catch (error) {
      const httpError = toHttpError(error);
      logError(request, httpError, error);
      const headers = {};
      if (httpError.status === 401) {
        headers["Set-Cookie"] = clearCookie(SESSION_COOKIE);
      }
      return jsonResponse(
        { error: httpError.code, message: httpError.message },
        httpError.status,
        request,
        env,
        headers,
      );
    }
  },
};

function validateEnvironment(env) {
  const required = [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SESSION_SECRET",
    "FRONTEND_ORIGIN",
    "AUTH_ORIGIN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_ALLOWED_LOGIN",
    "GITHUB_BRANCH",
    "GITHUB_FILE",
  ];

  for (const key of required) {
    if (!env[key]) throw new Error(`Missing Worker configuration: ${key}`);
  }

  if (String(env.SESSION_SECRET).length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  for (const key of ["FRONTEND_ORIGIN", "AUTH_ORIGIN"]) {
    const origin = new URL(env[key]);
    if (origin.protocol !== "https:" || origin.origin !== env[key]) {
      throw new Error(`${key} must be an HTTPS origin without a path.`);
    }
  }
}

async function startLogin(env) {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const callback = `${env.AUTH_ORIGIN}/auth/callback`;
  const stateCookie = await seal(
    { state, verifier, createdAt: Date.now() },
    env.SESSION_SECRET,
  );

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");

  const headers = new Headers({
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Set-Cookie": cookie(STATE_COOKIE, stateCookie, 10 * 60),
  });
  applySecurityHeaders(headers);
  return new Response(null, {
    status: 302,
    headers,
  });
}

async function finishLogin(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return redirectToFrontend(env, "cancelled", clearCookie(STATE_COOKIE));
  }

  try {
    if (!code || !returnedState) {
      throw new HttpError(400, "GitHub did not return a valid authorization response.", "invalid_callback");
    }

    const stateCookie = parseCookies(request.headers.get("Cookie"))[STATE_COOKIE];
    if (!stateCookie) {
      throw new HttpError(400, "The sign-in attempt expired. Start again.", "expired_state");
    }

    const saved = await unseal(stateCookie, env.SESSION_SECRET);
    if (!timingSafeEqual(saved.state, returnedState) || Date.now() - saved.createdAt > 10 * 60 * 1000) {
      throw new HttpError(400, "The sign-in state was invalid or expired.", "invalid_state");
    }

    const token = await exchangeCode(env, code, saved.verifier);
    const user = await githubRequest(env, token.access_token, "/user");

    if (String(user.login).toLowerCase() !== String(env.GITHUB_ALLOWED_LOGIN).toLowerCase()) {
      throw new HttpError(403, "This GitHub account is not allowed to manage t-b.es.", "account_not_allowed");
    }

    await githubRequest(env, token.access_token, filePath(env, true));

    const now = Date.now();
    const session = {
      version: 1,
      accessToken: token.access_token,
      accessExpiresAt: token.expires_in ? now + Number(token.expires_in) * 1000 : null,
      refreshToken: token.refresh_token || null,
      refreshExpiresAt: token.refresh_token_expires_in
        ? now + Number(token.refresh_token_expires_in) * 1000
        : null,
      login: user.login,
      name: user.name || user.login,
      avatarUrl: user.avatar_url || "",
      csrfToken: randomToken(24),
    };

    const encrypted = await seal(session, env.SESSION_SECRET);
    const headers = new Headers({
      Location: `${env.FRONTEND_ORIGIN}/?auth=success`,
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", sessionCookie(encrypted, session));
    headers.append("Set-Cookie", clearCookie(STATE_COOKIE));
    applySecurityHeaders(headers);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    const httpError = toHttpError(error);
    logError(request, httpError, error);
    return redirectToFrontend(env, httpError.code, clearCookie(STATE_COOKIE));
  }
}

async function exchangeCode(env, code, verifier) {
  return oauthTokenRequest({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: `${env.AUTH_ORIGIN}/auth/callback`,
    code_verifier: verifier,
    repository_id: env.GITHUB_REPOSITORY_ID,
  });
}

async function refreshAccessToken(env, session) {
  if (!session.refreshToken) {
    throw new HttpError(401, "Your GitHub session expired. Sign in again.", "reauth_required");
  }
  if (session.refreshExpiresAt && Date.now() >= session.refreshExpiresAt) {
    throw new HttpError(401, "Your GitHub session expired. Sign in again.", "reauth_required");
  }

  const token = await oauthTokenRequest({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  });
  const now = Date.now();

  return {
    ...session,
    accessToken: token.access_token,
    accessExpiresAt: token.expires_in ? now + Number(token.expires_in) * 1000 : null,
    refreshToken: token.refresh_token || session.refreshToken,
    refreshExpiresAt: token.refresh_token_expires_in
      ? now + Number(token.refresh_token_expires_in) * 1000
      : session.refreshExpiresAt,
  };
}

async function oauthTokenRequest(parameters) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
  const data = await readJsonResponse(response, MAX_BODY_BYTES, "GitHub authorization");

  if (!response.ok || data?.error || !data?.access_token) {
    throw new HttpError(
      401,
      data?.error_description || data?.error || "GitHub authorization failed.",
      "github_authorization_failed",
    );
  }

  return data;
}

async function requireSession(request, env) {
  const encrypted = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!encrypted) throw new HttpError(401, "Sign in with GitHub to continue.", "authentication_required");

  let session;
  try {
    session = await unseal(encrypted, env.SESSION_SECRET);
  } catch {
    throw new HttpError(401, "The saved session could not be read. Sign in again.", "invalid_session");
  }

  if (String(session.login).toLowerCase() !== String(env.GITHUB_ALLOWED_LOGIN).toLowerCase()) {
    throw new HttpError(403, "This GitHub account is not allowed.", "account_not_allowed");
  }

  let setCookie = "";
  if (session.accessExpiresAt && Date.now() + ACCESS_REFRESH_SKEW_MS >= session.accessExpiresAt) {
    session = await refreshAccessToken(env, session);
    setCookie = sessionCookie(await seal(session, env.SESSION_SECRET), session);
  }

  return { session, setCookie };
}

function assertCsrf(request, session) {
  const supplied = request.headers.get("X-CSRF-Token") || "";
  if (!timingSafeEqual(supplied, session.csrfToken || "")) {
    throw new HttpError(403, "The security token was invalid. Reload and try again.", "invalid_csrf");
  }
}

function assertFrontendOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== env.FRONTEND_ORIGIN) {
    throw new HttpError(403, "This origin is not allowed.", "origin_not_allowed");
  }
}

function handleOptions(request, env) {
  assertFrontendOrigin(request, env);
  const headers = corsHeaders(request, env);
  applySecurityHeaders(headers);
  return new Response(null, {
    status: 204,
    headers,
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (origin === env.FRONTEND_ORIGIN) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(data, status, request, env, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  applySecurityHeaders(headers);
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (value) headers.append(name, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function redirectToFrontend(env, result, setCookieHeader = "") {
  const target = new URL(env.FRONTEND_ORIGIN);
  target.searchParams.set("auth", result);
  const headers = new Headers({ Location: target.toString(), "Cache-Control": "no-store" });
  applySecurityHeaders(headers);
  if (setCookieHeader) headers.append("Set-Cookie", setCookieHeader);
  return new Response(null, { status: 302, headers });
}

async function githubRequest(env, accessToken, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("X-GitHub-Api-Version", env.GITHUB_API_VERSION || "2026-03-10");
  headers.set("User-Agent", "t-b.es-redirect-manager");
  if (options.body) headers.set("Content-Type", "application/json");

  const response = await fetch(`https://api.github.com${path}`, { ...options, headers });
  const data = await readJsonResponse(response, MAX_UPSTREAM_BYTES, "GitHub API");

  if (!response.ok) {
    const status = response.status === 401 ? 401 : response.status;
    throw new HttpError(status, data?.message || `GitHub returned HTTP ${response.status}.`, "github_api_error");
  }
  return data;
}

function filePath(env, includeRef) {
  const path = `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodeURIComponent(env.GITHUB_FILE)}`;
  return includeRef ? `${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}` : path;
}

function parseRedirectFile(file) {
  if (!file || typeof file.content !== "string" || typeof file.sha !== "string") {
    throw new HttpError(502, "GitHub returned an invalid hello.txt response.", "invalid_github_response");
  }
  const parsed = JSON.parse(decodeBase64Utf8(file.content.replace(/\s/g, "")));
  return validateRedirects(parsed);
}

export function validateRedirects(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(400, "Redirects must be a JSON object.", "invalid_redirects");
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_REDIRECTS) {
    throw new HttpError(400, `At most ${MAX_REDIRECTS} redirects may be configured.`, "too_many_redirects");
  }

  const redirects = {};
  for (const [key, rawDestination] of entries) {
    if (!/^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key)) {
      throw new HttpError(400, `Invalid redirect name: ${key}`, "invalid_redirect_name");
    }
    if (RESERVED_KEYS.has(key)) {
      throw new HttpError(400, `${key}.t-b.es is reserved for the manager service.`, "reserved_redirect_name");
    }
    if (typeof rawDestination !== "string") {
      throw new HttpError(400, `Invalid destination for ${key}.`, "invalid_destination");
    }
    if (rawDestination.length > MAX_DESTINATION_LENGTH) {
      throw new HttpError(
        400,
        `Destination for ${key} may be at most ${MAX_DESTINATION_LENGTH} characters.`,
        "invalid_destination",
      );
    }

    let destination;
    try {
      destination = new URL(rawDestination);
    } catch {
      throw new HttpError(400, `Invalid destination for ${key}.`, "invalid_destination");
    }
    if (!["http:", "https:"].includes(destination.protocol)) {
      throw new HttpError(400, `Destination for ${key} must use HTTP or HTTPS.`, "invalid_destination");
    }
    redirects[key] = destination.href;
  }

  return Object.fromEntries(Object.entries(redirects).sort(([a], [b]) => a.localeCompare(b)));
}

export function serialiseRedirects(redirects) {
  return `${JSON.stringify(validateRedirects(redirects), null, 2)}\n`;
}

async function readJsonBody(request) {
  const text = await readLimitedText(
    request,
    MAX_BODY_BYTES,
    413,
    "Request body is too large.",
    "body_too_large",
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function requireString(value, message) {
  const result = String(value || "").trim();
  if (!result) throw new HttpError(400, message, "invalid_input");
  return result;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function sessionCookie(value, session) {
  const expiry = session.refreshExpiresAt || session.accessExpiresAt || Date.now() + DEFAULT_SESSION_MS;
  const maxAge = Math.max(60, Math.floor((expiry - Date.now()) / 1000));
  return cookie(SESSION_COOKIE, value, maxAge);
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

async function seal(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

async function unseal(value, secret) {
  const [ivPart, encryptedPart] = String(value || "").split(".");
  if (!ivPart || !encryptedPart) throw new Error("Invalid sealed value");
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(ivPart) },
    key,
    base64UrlDecode(encryptedPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function randomToken(bytes) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof SyntaxError) return new HttpError(502, "hello.txt is not valid JSON.", "invalid_redirect_file");
  return new HttpError(500, "Unexpected server error.", "server_error");
}

async function readJsonResponse(response, maxBytes, source) {
  const text = await readLimitedText(
    response,
    maxBytes,
    502,
    `${source} returned an unexpectedly large response.`,
  );
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `${source} returned invalid JSON.`, "invalid_upstream_response");
  }
}

async function readLimitedText(
  message,
  maxBytes,
  status,
  errorMessage,
  errorCode = "response_too_large",
) {
  const declaredLength = Number(message.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(status, errorMessage, errorCode);
  }

  if (!message.body) return "";
  const reader = message.body.getReader();
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
        throw new HttpError(status, errorMessage, errorCode);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function applySecurityHeaders(headers) {
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
}

function logError(request, httpError, cause) {
  if (httpError.status < 500) return;
  const url = new URL(request.url);
  console.error({
    event: "request_failed",
    code: httpError.code,
    status: httpError.status,
    method: request.method,
    path: url.pathname,
    cause: cause instanceof Error ? cause.name : "UnknownError",
  });
}
