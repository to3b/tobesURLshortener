import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";
import { parseCookies, serialiseRedirects, validateRedirects } from "../src/index.js";
import { shortRedirectKey } from "../src/short-redirects.js";

test("validates and sorts redirects", () => {
  assert.deepEqual(
    validateRedirects({ z: "https://example.com/z", a: "http://example.com" }),
    { a: "http://example.com/", z: "https://example.com/z" },
  );
});

test("rejects invalid names, protocols, and reserved service hostnames", () => {
  assert.throws(() => validateRedirects({ "Bad Name": "https://example.com" }));
  assert.throws(() => validateRedirects({ ftp: "ftp://example.com" }));
  assert.throws(() => validateRedirects({ auth: "https://example.com" }));
  assert.throws(() => validateRedirects({ www: "https://example.com" }));
});

test("bounds the redirect map and destination length", () => {
  const tooMany = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [`link-${index}`, "https://example.com"]),
  );
  assert.throws(() => validateRedirects(tooMany), /At most 500/);
  assert.throws(() => validateRedirects({ long: `https://example.com/${"x".repeat(2049)}` }), /at most 2048/);
});

test("serialises with stable formatting", () => {
  assert.equal(
    serialiseRedirects({ b: "https://b.example", a: "https://a.example" }),
    '{\n  "a": "https://a.example/",\n  "b": "https://b.example/"\n}\n',
  );
});

test("parses cookie headers without splitting values on equals signs", () => {
  assert.deepEqual(parseCookies("one=1; session=abc==; empty="), {
    one: "1",
    session: "abc==",
    empty: "",
  });
});

const env = {
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "secret",
  SESSION_SECRET: "a-long-random-session-secret-32-bytes",
  FRONTEND_ORIGIN: "https://t-b.es",
  AUTH_ORIGIN: "https://auth.t-b.es",
  GITHUB_OWNER: "to3b",
  GITHUB_REPO: "tobesURLshortener",
  GITHUB_REPOSITORY_ID: "1061521737",
  GITHUB_ALLOWED_LOGIN: "to3b",
  GITHUB_BRANCH: "main",
  GITHUB_FILE: "hello.txt",
  GITHUB_API_VERSION: "2026-03-10",
};

test("extracts short-link keys without taking over auth or apex hosts", () => {
  assert.equal(shortRedirectKey("g.t-b.es", env), "g");
  assert.equal(shortRedirectKey("G.T-B.ES.", env), "g");
  assert.equal(shortRedirectKey("auth.t-b.es", env), null);
  assert.equal(shortRedirectKey("www.t-b.es", env), null);
  assert.equal(shortRedirectKey("t-b.es", env), null);
  assert.equal(shortRedirectKey("example.com", env), null);
});

test("wildcard subdomains redirect through the Worker", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"g":"https://google.com"}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const response = await worker.fetch(new Request("https://g.t-b.es/"), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://google.com/");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown wildcard subdomains return a clean 404", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"g":"https://google.com"}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const response = await worker.fetch(new Request("https://missing.t-b.es/"), env);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /No redirect is configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("www redirects to the apex manager", async () => {
  const response = await worker.fetch(new Request("https://www.t-b.es/path?x=1"), env);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://t-b.es/path?x=1");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("wildcard redirect routes allow only GET and HEAD", async () => {
  const response = await worker.fetch(
    new Request("https://g.t-b.es/", { method: "POST" }),
    env,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("invalid nested wildcard hosts cannot reach authentication routes", async () => {
  const response = await worker.fetch(new Request("https://nested.name.t-b.es/health"), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("GitHub authorization URL omits token-exchange-only parameters", async () => {
  const response = await worker.fetch(new Request("https://auth.t-b.es/auth/login"), env);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "client");
  assert.equal(location.searchParams.has("repository_id"), false);
});

test("health endpoint returns CORS-safe JSON", async () => {
  const response = await worker.fetch(
    new Request("https://auth.t-b.es/health", { headers: { Origin: "https://t-b.es" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://t-b.es");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.deepEqual(await response.json(), { ok: true });
});

test("session endpoint requires an authenticated cookie", async () => {
  const response = await worker.fetch(
    new Request("https://auth.t-b.es/api/session", { headers: { Origin: "https://t-b.es" } }),
    env,
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "authentication_required");
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("API rejects an unrelated origin", async () => {
  const response = await worker.fetch(
    new Request("https://auth.t-b.es/api/session", { headers: { Origin: "https://evil.example" } }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
