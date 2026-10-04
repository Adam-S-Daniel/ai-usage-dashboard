import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";

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
    addEventListener() {}, setInterval() {}, console, Date, URL,
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
  await settle();
  return { ctx, els, fetched, store, app: () => els["#app"].innerHTML, settle };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

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
