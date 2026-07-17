import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

let bootSequence = 0;

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function bootLinkDesk({ authenticated = false } = {}) {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../hello.txt", import.meta.url), "utf8");
  const redirects = JSON.parse(source);
  const content = Buffer.from(source, "utf8").toString("base64");
  const published = [];
  const dom = new JSDOM(html, { url: "https://t-b.es/", pretendToBeVisual: true });
  const { window } = dom;

  window.confirm = () => true;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  Object.assign(globalThis, {
    window,
    document: window.document,
    history: window.history,
    sessionStorage: window.sessionStorage,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
  });

  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/api/session")) {
      if (authenticated) {
        return Response.json({
          authenticated: true,
          user: { login: "to3b", name: "Toby", avatarUrl: "" },
          csrfToken: "test-csrf",
        });
      }
      return Response.json(
        { error: "authentication_required", message: "Sign in to continue." },
        { status: 401 },
      );
    }
    if (url.includes("/api/redirects")) {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        published.push(body);
        return Response.json({ redirects: body.redirects, sha: "published-sha" });
      }
      return Response.json({ redirects, sha: "test-sha" });
    }
    if (url.startsWith("https://api.github.com/")) {
      return Response.json({ content, sha: "test-sha" });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  bootSequence += 1;
  await import(`../assets/app.js?test=${bootSequence}`);
  await waitFor(
    () => document.getElementById("status-message").textContent.startsWith("Loaded"),
    "The redirect list did not finish loading.",
  );

  return { dom, redirects, published };
}

function submitRedirect(window, key, destination) {
  document.getElementById("key").value = key;
  document.getElementById("destination").value = destination;
  document.getElementById("redirect-form").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

test("the read-only link desk loads, filters, stages, and undoes redirects", async () => {
  const { dom, redirects } = await bootLinkDesk();
  const { window } = dom;

  assert.equal(document.getElementById("redirect-count").textContent, String(Object.keys(redirects).length));
  assert.equal(document.querySelectorAll(".redirect-row").length, Object.keys(redirects).length);
  assert.equal(document.getElementById("connection-label").textContent, "Read-only");
  assert.equal(document.querySelectorAll("button:not([type])").length, 0);
  assert.equal(document.querySelectorAll('a[target="_blank"]:not([rel~="noopener"])').length, 0);
  for (const input of document.querySelectorAll("input")) {
    assert.ok(input.labels.length > 0 || input.getAttribute("aria-label"), `${input.id} needs a label`);
  }

  submitRedirect(window, "docs", "https://example.com/guide");
  assert.equal(document.getElementById("change-count").textContent, "1");
  assert.equal(document.getElementById("changes-panel").hidden, false);
  assert.equal(document.getElementById("publish-button").disabled, true);
  assert.match(document.getElementById("status-message").textContent, /Added docs\.t-b\.es/);

  const search = document.getElementById("search");
  search.value = "youtube";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(document.querySelectorAll(".redirect-row").length, 1);
  assert.match(document.querySelector(".short-link").textContent, /^y\.t-b\.es$/);

  document.querySelector(".change-item .text-button").click();
  assert.equal(document.getElementById("change-count").textContent, "0");
  assert.equal(document.getElementById("changes-panel").hidden, true);

  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  submitRedirect(window, "www", "https://example.com");
  assert.match(document.getElementById("status-message").textContent, /reserved/);
  assert.equal(document.getElementById("change-count").textContent, "0");

  dom.window.close();
});

test("an authenticated owner can publish a staged redirect", async () => {
  const { dom, published } = await bootLinkDesk({ authenticated: true });
  const { window } = dom;

  assert.equal(document.getElementById("connection-label").textContent, "@to3b");
  submitRedirect(window, "docs", "https://example.com/guide");
  assert.equal(document.getElementById("publish-button").disabled, false);

  document.getElementById("publish-button").click();
  await waitFor(
    () => document.getElementById("status-message").textContent.startsWith("Published successfully"),
    "The staged redirect was not published.",
  );

  assert.equal(published.length, 1);
  assert.equal(published[0].sha, "test-sha");
  assert.equal(published[0].message, "Update redirects from link desk");
  assert.equal(published[0].redirects.docs, "https://example.com/guide");
  assert.equal(document.getElementById("change-count").textContent, "0");
  assert.equal(document.getElementById("publish-button").disabled, true);

  dom.window.close();
});
