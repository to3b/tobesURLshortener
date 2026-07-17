export const MAX_REDIRECTS = 500;
export const MAX_DESTINATION_LENGTH = 2048;
export const RESERVED_KEYS = new Set(["auth", "www"]);

const KEY_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function canonicalise(redirects) {
  return Object.fromEntries(
    Object.entries(redirects).sort(([left], [right]) => left.localeCompare(right, "en")),
  );
}

export function cloneRedirects(redirects) {
  return { ...redirects };
}

export function normaliseKey(value, domain = "t-b.es") {
  let key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/, 1)[0]
    .replace(/\.$/, "");

  const suffix = `.${String(domain).toLowerCase()}`;
  if (key.endsWith(suffix)) key = key.slice(0, -suffix.length);
  return key;
}

export function validateKey(key) {
  return KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key);
}

export function keyValidationMessage(key, domain = "t-b.es") {
  if (RESERVED_KEYS.has(key)) return `${key}.${domain} is reserved by the service.`;
  return "Use 1–63 lowercase letters, numbers, or hyphens; do not start or end with a hyphen.";
}

export function normaliseDestination(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) throw new Error("Enter a destination URL.");
  if (rawValue.length > MAX_DESTINATION_LENGTH) {
    throw new Error(`Destination URLs may be at most ${MAX_DESTINATION_LENGTH} characters.`);
  }

  let destination;
  try {
    destination = new URL(rawValue);
  } catch {
    throw new Error("Enter a complete destination URL, including https://.");
  }

  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Destination must use http:// or https://.");
  }
  return destination.href;
}

export function validateRedirectMap(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("hello.txt must contain a JSON object.");
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_REDIRECTS) {
    throw new Error(`The redirect map may contain at most ${MAX_REDIRECTS} links.`);
  }

  const redirects = {};
  for (const [rawKey, rawDestination] of entries) {
    const key = normaliseKey(rawKey);
    if (key !== rawKey || !validateKey(key) || typeof rawDestination !== "string") {
      throw new Error(`Invalid redirect entry: ${rawKey}`);
    }
    redirects[key] = normaliseDestination(rawDestination);
  }
  return canonicalise(redirects);
}

export function decodeBase64Utf8(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseRedirectFile(file) {
  if (!file || typeof file.content !== "string" || typeof file.sha !== "string") {
    throw new Error("GitHub returned an invalid redirect file.");
  }
  return validateRedirectMap(JSON.parse(decodeBase64Utf8(file.content)));
}

export function serialiseRedirects(redirects) {
  return `${JSON.stringify(canonicalise(redirects), null, 2)}\n`;
}

export function diffRedirects(baseline, redirects) {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(redirects)]);
  const changes = [];

  for (const key of [...keys].sort((left, right) => left.localeCompare(right, "en"))) {
    const before = baseline[key];
    const after = redirects[key];
    if (before === after) continue;

    changes.push({
      key,
      type: before === undefined ? "added" : after === undefined ? "removed" : "updated",
      before,
      after,
    });
  }
  return changes;
}

export function filterRedirects(redirects, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return Object.entries(redirects);
  return Object.entries(redirects).filter(
    ([key, destination]) =>
      key.toLowerCase().includes(needle) || destination.toLowerCase().includes(needle),
  );
}
