import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { validateRedirectMap } from "../assets/redirects.js";

const root = resolve(import.meta.dirname, "..");
const indexPath = resolve(root, "index.html");
const fallbackPath = resolve(root, "404.html");
const index = readFileSync(indexPath, "utf8");
const fallback = readFileSync(fallbackPath, "utf8");

for (const [name, html] of [
  ["index.html", index],
  ["404.html", fallback],
]) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, position) => ids.indexOf(id) !== position);
  if (duplicateIds.length) throw new Error(`${name} has duplicate IDs: ${duplicateIds.join(", ")}`);
}

for (const match of index.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const reference = match[1];
  if (/^(?:https?:|mailto:|data:)/.test(reference)) continue;
  const path = resolve(root, reference.split("?", 1)[0]);
  if (!existsSync(path)) throw new Error(`index.html references missing file: ${reference}`);
}

if (/<style(?:\s|>)/i.test(index)) throw new Error("index.html must not contain inline styles.");
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(index)) {
  throw new Error("index.html must not contain inline scripts.");
}

for (const match of fallback.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
  new vm.Script(match[1], { filename: "404.html:inline-script.js" });
}

const redirects = JSON.parse(readFileSync(resolve(root, "hello.txt"), "utf8"));
validateRedirectMap(redirects);

const cname = readFileSync(resolve(root, "CNAME"), "utf8").trim();
if (cname !== "t-b.es") throw new Error(`Unexpected CNAME: ${cname}`);

console.log("Static site validation passed.");
