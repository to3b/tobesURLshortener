import test from "node:test";
import assert from "node:assert/strict";
import worker, { parseCookies, serialiseRedirects, validateRedirects } from "../src/index.js";

test("validates and sorts redirects", () => {
  assert.deepEqual(
    validateRedirects({ z: "https://example.com/z", a: "http://example.com" }),
    { a: "http://example.com/", z: "https://example.com/z" },
  );
});

test("rejects invalid names, protocols, and reserved auth hostname", () => {
  assert.throws(() => validateRedirects({ "Bad Name": "https://example.com" }));
  assert.throws(() => validateRedirects({ ftp: "ftp://example.com" }));
  assert.throws(() => validateRedirects({ auth: "https://example.com" }));
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
  SESSION_SECRET: "a-long-random-session-secret",
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

test("health endpoint returns CORS-safe JSON", async () => {
  const response = await worker.fetch(
    new Request("https://auth.t-b.es/health", { headers: { Origin: "https://t-b.es" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://t-b.es");
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
