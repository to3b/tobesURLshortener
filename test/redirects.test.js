import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REDIRECTS,
  canonicalise,
  diffRedirects,
  filterRedirects,
  normaliseDestination,
  normaliseKey,
  parseRedirectFile,
  serialiseRedirects,
  validateKey,
  validateRedirectMap,
} from "../assets/redirects.js";

test("canonicalises and serialises redirect maps", () => {
  const redirects = { z: "https://z.example/", a: "https://a.example/" };
  assert.deepEqual(canonicalise(redirects), {
    a: "https://a.example/",
    z: "https://z.example/",
  });
  assert.equal(
    serialiseRedirects(redirects),
    '{\n  "a": "https://a.example/",\n  "z": "https://z.example/"\n}\n',
  );
});

test("normalises pasted short links", () => {
  assert.equal(normaliseKey("  HTTPS://Docs.T-B.ES/path?q=1  "), "docs");
  assert.equal(normaliseKey("notes"), "notes");
});

test("validates DNS-safe names and reserves service hosts", () => {
  assert.equal(validateKey("docs-2"), true);
  assert.equal(validateKey("auth"), false);
  assert.equal(validateKey("www"), false);
  assert.equal(validateKey("Bad Name"), false);
  assert.equal(validateKey("-docs"), false);
});

test("normalises only HTTP and HTTPS destinations", () => {
  assert.equal(normaliseDestination("https://example.com"), "https://example.com/");
  assert.throws(() => normaliseDestination("javascript:alert(1)"), /http:\/\//i);
  assert.throws(() => normaliseDestination("not a url"), /complete destination/i);
});

test("validates redirect maps without silently rewriting keys", () => {
  assert.deepEqual(validateRedirectMap({ docs: "https://example.com" }), {
    docs: "https://example.com/",
  });
  assert.throws(() => validateRedirectMap({ Docs: "https://example.com" }), /Invalid redirect/);
  assert.throws(() => validateRedirectMap({ www: "https://example.com" }), /Invalid redirect/);

  const oversized = Object.fromEntries(
    Array.from({ length: MAX_REDIRECTS + 1 }, (_, index) => [`link-${index}`, "https://example.com"]),
  );
  assert.throws(() => validateRedirectMap(oversized), /at most/);
});

test("parses GitHub's base64 file response as UTF-8", () => {
  const source = '{"cafe":"https://example.com/caf%C3%A9"}';
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  assert.deepEqual(parseRedirectFile({ content: btoa(binary), sha: "abc123" }), {
    cafe: "https://example.com/caf%C3%A9",
  });
});

test("describes additions, edits, and removals", () => {
  assert.deepEqual(
    diffRedirects(
      { edit: "https://old.example/", remove: "https://remove.example/" },
      { add: "https://add.example/", edit: "https://new.example/" },
    ),
    [
      { key: "add", type: "added", before: undefined, after: "https://add.example/" },
      {
        key: "edit",
        type: "updated",
        before: "https://old.example/",
        after: "https://new.example/",
      },
      {
        key: "remove",
        type: "removed",
        before: "https://remove.example/",
        after: undefined,
      },
    ],
  );
});

test("filters by short name or destination", () => {
  const redirects = {
    docs: "https://example.com/guide",
    video: "https://youtube.com/watch?v=1",
  };
  assert.deepEqual(filterRedirects(redirects, "GUIDE"), [["docs", "https://example.com/guide"]]);
  assert.deepEqual(filterRedirects(redirects, "video"), [["video", "https://youtube.com/watch?v=1"]]);
});
