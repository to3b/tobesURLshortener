(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }

  root.TbesRedirect = api;
  root.addEventListener("DOMContentLoaded", () => api.start());
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function normaliseHostname(hostname) {
    return String(hostname || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
  }

  function getRedirectKey(hostname, rootDomain) {
    const host = normaliseHostname(hostname);
    const root = normaliseHostname(rootDomain);

    if (!host || !root || host === root || host === `www.${root}`) {
      return null;
    }

    const suffix = `.${root}`;
    if (host.endsWith(suffix)) {
      return host.slice(0, -suffix.length) || null;
    }

    // Keeps local and GitHub Pages previews useful without affecting t-b.es.
    return host.split(".")[0] || null;
  }

  function normaliseTarget(value) {
    if (typeof value !== "string" || value.trim() === "") {
      return null;
    }

    try {
      const target = new URL(value.trim());
      return target.protocol === "http:" || target.protocol === "https:"
        ? target
        : null;
    } catch {
      return null;
    }
  }

  function setMessage(documentRef, title, detail) {
    const titleElement = documentRef.getElementById("status-title");
    const detailElement = documentRef.getElementById("status-detail");

    if (titleElement) titleElement.textContent = title;
    if (detailElement) detailElement.textContent = detail;
  }

  async function loadRedirects(fetchImpl, redirectsFile) {
    const response = await fetchImpl(redirectsFile, {
      cache: "no-store",
      headers: { Accept: "application/json, text/plain;q=0.9" },
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

  async function start(options) {
    const settings = options || {};
    const windowRef = settings.windowRef || window;
    const documentRef = settings.documentRef || document;
    const fetchImpl = settings.fetchImpl || windowRef.fetch.bind(windowRef);
    const rootDomain =
      documentRef.documentElement.dataset.rootDomain || "t-b.es";
    const redirectsFile =
      documentRef.documentElement.dataset.redirectsFile || "/hello.txt";
    const key = getRedirectKey(windowRef.location.hostname, rootDomain);

    if (!key) {
      setMessage(
        documentRef,
        "No redirect requested",
        `Use a configured subdomain such as name.${rootDomain}.`
      );
      return;
    }

    setMessage(documentRef, "Checking redirect…", `Looking up “${key}”.`);

    try {
      const redirects = await loadRedirects(fetchImpl, redirectsFile);
      const hasKey = Object.prototype.hasOwnProperty.call(redirects, key);
      const target = hasKey ? normaliseTarget(redirects[key]) : null;

      if (!hasKey) {
        setMessage(
          documentRef,
          "Redirect not found",
          `There is no destination configured for “${key}”.`
        );
        return;
      }

      if (!target) {
        setMessage(
          documentRef,
          "Redirect unavailable",
          "The configured destination is not a valid HTTP or HTTPS URL."
        );
        return;
      }

      setMessage(
        documentRef,
        "Redirecting…",
        `Taking you to ${target.hostname}.`
      );
      windowRef.location.replace(target.href);
    } catch (error) {
      console.error("Unable to load redirect map:", error);
      setMessage(
        documentRef,
        "Redirect unavailable",
        "The redirect list could not be loaded. Try again shortly."
      );
    }
  }

  return Object.freeze({
    getRedirectKey,
    loadRedirects,
    normaliseHostname,
    normaliseTarget,
    start,
  });
});
