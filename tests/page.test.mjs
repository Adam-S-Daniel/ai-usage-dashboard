import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const html = fs.readFileSync(process.env.PAGE ?? new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const A = "a".repeat(20), B = "b".repeat(20);

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const day = (i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
const validDoc = () => ({
  schema: 1, generated_at: iso(-6e4), host: "example-host",
  sources: {
    claude: { ok: true, fetched_at: iso(), plan: "max", windows: [{ id: "five_hour", label: "Session (5 h)", used_pct: 12.5, resets_at: iso(36e5), period_seconds: 18000 }] },
    codex: { ok: false, error: "Sample failure", plan: null, windows: [] },
    platform: { ok: true, fetched_at: iso(),
      usage: [{ date: day(1), model: "example-model", input: 1200, cache_write: 0, cache_read: 5000, output: 300 }],
      costs: [{ date: day(1), model: "example-model", usd: 1.25 }] },
  },
});

// Runs the page script against stubs; gists maps id -> usage document (or raw usage.json text).
async function boot({ hash = "", saved = {}, gists = {} } = {}) {
  const els = {}, fetched = [], store = new Map(Object.entries(saved));
  const el = () => ({ textContent: "", innerHTML: "", disabled: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
  const ctx = {
    document: { querySelector: (s) => (els[s] ||= el()), querySelectorAll: () => [], addEventListener() {}, hidden: false },
    addEventListener() {}, setInterval() {}, console, Date, URL, atob, TextDecoder, crypto: globalThis.crypto,
    location: { hash, pathname: "/page", search: "" },
    history: { replaceState(_s, _t, url) { ctx.location.hash = ""; ctx.replaced = url; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url) => {
      fetched.push(url);
      const id = String(url).split("/").pop(), g = gists[id];
      if (g === undefined) return { ok: false, status: 404 };
      const content = typeof g === "string" ? g : JSON.stringify(g);
      return { ok: true, json: async () => ({ files: { "usage.json": { content } } }) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const settle = async () => {   // WebCrypto resolves off the event loop, so wait for the load to finish
    for (let i = 0; i < 20 || els["#refresh"]?.disabled; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  return { ctx, els, fetched, store, app: () => els["#app"].innerHTML, settle };
}

test("a: string token count cannot inject markup and is not persisted", async () => {
  const doc = validDoc();
  doc.sources.platform.usage[0].input = "<img src=x onerror=globalThis.pwned=1>";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /<img/);
  assert.match(p.app(), /usage\.json is malformed: sources\.platform\.usage\[0\]\.input/);
  assert.equal(p.store.has("gist"), false);
});

test("b: hostile date cannot inject markup and is not persisted", async () => {
  const doc = validDoc();
  doc.sources.platform.costs[0].date = '2026-10-01"><img src=x>';
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /<img/);
  assert.match(p.app(), /malformed/);
  assert.equal(p.store.has("gist"), false);
});

test("c: a valid document renders the model table and persists the id", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: validDoc() } });
  assert.match(p.app(), /<td>example-model<\/td>/);
  assert.match(p.app(), /\$1\.25/);
  assert.equal(p.store.get("gist"), A);
});

test("d: a fragment differing from the saved id asks before fetching", async () => {
  const p = await boot({ hash: "#" + B, saved: { gist: A }, gists: { [A]: validDoc(), [B]: validDoc() } });
  assert.equal(p.fetched.some((u) => u.endsWith(B)), false);
  assert.match(p.app(), /different data source/);
  assert.equal(p.store.get("gist"), A);
  p.els["#adopt"].handlers.click();
  await p.settle();
  assert.equal(p.fetched.some((u) => u.endsWith(B)), true);
  assert.equal(p.store.get("gist"), B);
});

test("d2: keeping the saved id clears the fragment and loads the saved gist", async () => {
  const p = await boot({ hash: "#" + B, saved: { gist: A }, gists: { [A]: validDoc(), [B]: validDoc() } });
  p.els["#keep"].handlers.click();
  await p.settle();
  assert.equal(p.ctx.replaced, "/page");
  assert.equal(p.fetched.some((u) => u.endsWith(B)), false);
  assert.equal(p.fetched.some((u) => u.endsWith(A)), true);
  assert.equal(p.store.get("gist"), A);
});

test("e: demo data passes validation and #demo persists nothing", async () => {
  const p = await boot({ hash: "#demo" });
  assert.doesNotThrow(() => vm.runInContext("validateUsage(demo())", p.ctx));
  assert.match(p.app(), /sample-model-large/);
  assert.equal(p.store.size, 0);
  assert.equal(p.fetched.length, 0);
});

test("f: CSP hash matches the single inline script and no inline handlers exist", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  assert.ok(csp, "CSP meta tag present");
  const hash = crypto.createHash("sha256").update(script, "utf8").digest("base64");
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), "script-src carries the script hash");
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), "CSP precedes the script");
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("g: a far-past or far-future date is rejected", async () => {
  for (const d of ["0001-01-01", day(-10)]) {
    const doc = validDoc();
    doc.sources.platform.costs[0].date = d;
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), /malformed: sources\.platform\.costs\[0\]\.date/);
    assert.equal(p.store.has("gist"), false);
  }
});

// Same envelope format as collector Protect-UsageJson.
const newKey = () => crypto.randomBytes(32).toString("base64url");
function encrypt(doc, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  const ct = Buffer.concat([c.update(typeof doc === "string" ? doc : JSON.stringify(doc), "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, enc: "A256GCM", iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

test("h: encrypted document with the right key renders and persists id.key", async () => {
  const key = newKey();
  const p = await boot({ hash: `#${A}.${key}`, gists: { [A]: encrypt(validDoc(), key) } });
  assert.match(p.app(), /<td>example-model<\/td>/);
  assert.equal(p.store.get("gist"), `${A}.${key}`);
});

test("i: wrong key shows a decrypt error, persists nothing and renders no data", async () => {
  const p = await boot({ hash: `#${A}.${newKey()}`, gists: { [A]: encrypt(validDoc(), newKey()) } });
  assert.match(p.app(), /Could not decrypt usage\.json: the link's key does not match\./);
  assert.doesNotMatch(p.app(), /example-model/);
  assert.equal(p.store.has("gist"), false);
});

test("j: a key in the link with a plaintext gist is rejected (no downgrade)", async () => {
  const p = await boot({ hash: `#${A}.${newKey()}`, gists: { [A]: validDoc() } });
  assert.match(p.app(), /Expected encrypted data but the gist is not encrypted\./);
  assert.doesNotMatch(p.app(), /example-model/);
  assert.equal(p.store.has("gist"), false);
});

test("k: an encrypted gist behind a legacy link without a key says so", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: encrypt(validDoc(), newKey()) } });
  assert.match(p.app(), /This data is encrypted\. Open the full link Install\.ps1 printed/);
  assert.equal(p.store.has("gist"), false);
});

test("l: the choice card shows only gist ids, never a key", async () => {
  const k1 = newKey(), k2 = newKey();
  const p = await boot({ hash: `#${B}.${k1}`, saved: { gist: `${A}.${k2}` }, gists: {} });
  assert.match(p.app(), /different data source/);
  assert.ok(p.app().includes(A) && p.app().includes(B));
  assert.equal(p.app().includes(k1), false);
  assert.equal(p.app().includes(k2), false);
  assert.equal(p.fetched.length, 0);
});

test("m: a document encrypted by the PowerShell collector decrypts in the page", async (t) => {
  const key = newKey(), psm1 = fileURLToPath(new URL("../collector/AiUsage.psm1", import.meta.url));
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", "Import-Module $env:T_MODULE -Force; Protect-UsageJson -Json $env:T_JSON -Key $env:T_KEY"],
    { encoding: "utf8", env: { ...process.env, T_MODULE: psm1, T_KEY: key, T_JSON: JSON.stringify(validDoc()) } });
  if (r.error?.code === "ENOENT") return t.skip("pwsh is not on PATH");
  assert.equal(r.status, 0, r.stderr);
  const p = await boot({ hash: `#${A}.${key}`, gists: { [A]: r.stdout.trim() } });
  assert.match(p.app(), /<td>example-model<\/td>/);
  assert.equal(p.store.get("gist"), `${A}.${key}`);
});
