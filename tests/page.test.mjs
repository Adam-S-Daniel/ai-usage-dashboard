import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import crypto from "node:crypto";

// Browsers normalize CRLF to LF before hashing an inline script, so the test does too.
const html = fs.readFileSync(process.env.PAGE ?? new URL("../index.html", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const A = "a".repeat(20), B = "b".repeat(20);

// A fixed clock keeps the suite deterministic; the page sees it as Date.
const NOW = Date.parse("2026-10-04T12:00:00Z");
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const iso = (ms = 0) => new Date(NOW + ms).toISOString();
const day = (i) => new Date(NOW - i * 864e5).toISOString().slice(0, 10);
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
// A gists value may also be a function (id) => response promise, to control timing.
// failOn: markup containing this string makes the #app innerHTML setter throw, like a DOM error.
async function boot({ hash = "", saved = {}, gists = {}, failOn = null } = {}) {
  const els = {}, fetched = [], store = new Map(Object.entries(saved));
  const el = () => ({ textContent: "", innerHTML: "", disabled: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
  const app = el();
  let html_ = "";
  Object.defineProperty(app, "innerHTML", { get: () => html_, set(v) { if (failOn && String(v).includes(failOn)) throw new Error("boom"); html_ = v; } });
  els["#app"] = app;
  const listeners = {};
  const ctx = {
    listeners,
    document: { querySelector: (s) => (els[s] ||= el()), querySelectorAll: () => [], addEventListener(t, f) { listeners["doc:" + t] = f; }, hidden: false },
    addEventListener(t, f) { listeners[t] = f; }, setInterval() {}, console, Date: FakeDate, URL,
    location: { hash, pathname: "/page", search: "" },
    history: { replaceState(_s, _t, url) { ctx.location.hash = ""; ctx.replaced = url; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url) => {
      fetched.push(url);
      const id = String(url).split("/").pop(), g = gists[id];
      if (typeof g === "function") return g(id);
      if (g === undefined) return { ok: false, status: 404 };
      const content = typeof g === "string" ? g : JSON.stringify(g);
      return { ok: true, json: async () => ({ files: { "usage.json": { content } } }) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await settle();
  return { ctx, els, fetched, store, app: () => els["#app"].innerHTML, settle, hash: async (h) => { ctx.location.hash = h; await ctx.listeners.hashchange(); await settle(); } };
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

const doc1 = (model, extra = {}) => { const d = validDoc(); d.sources.platform.usage[0].model = model; d.sources.platform.costs[0].model = model; return Object.assign(d, extra); };
const resp = (doc) => ({ ok: true, json: async () => ({ files: { "usage.json": { content: JSON.stringify(doc) } } }) });
const deferred = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };

test("h: the crashing gist (year-0001 dates) is rejected, not saved, and the page is not blank", async () => {
  const doc = validDoc();
  doc.generated_at = "0001-06-01T00:00:00Z";
  doc.sources.platform.costs[0].date = "0001-01-01";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /malformed: generated_at/);
  assert.equal(p.store.has("gist"), false);
});

test("h2: generated_at far in the future or the past is rejected", async () => {
  for (const g of [iso(3 * 864e5), iso(-6 * 365 * 864e5)]) {
    const doc = validDoc();
    doc.generated_at = g;
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), /malformed: generated_at/);
    assert.equal(p.store.has("gist"), false);
  }
});

test("h3: the chart draws at most 400 days even when handed unvalidated years-old dates", async () => {
  const p = await boot();
  p.ctx.src = { ok: true, usage: [], costs: [{ date: "0001-01-01", model: "m", usd: 1 }, { date: day(0), model: "m", usd: 2 }] };
  const out = vm.runInContext("platformCard(src)", p.ctx);
  const hits = out.match(/class="hit"/g).length;
  assert.ok(hits >= 1 && hits <= 400, "hit rects: " + hits);
});

test("h4: a render failure shows an error state and does not save the id", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: doc1("RENDER-BOOM") }, failOn: "RENDER-BOOM" });
  assert.equal(p.store.has("gist"), false);
  assert.match(p.app(), /Could not display the data: boom/);
  assert.equal(p.els["#updated"].textContent, "Error");
});

test("i: model names like __proto__, constructor and toString each get their own row", async () => {
  const doc = validDoc();
  const names = ["__proto__", "constructor", "toString"];
  doc.sources.platform.usage = names.map((model) => ({ date: day(1), model, input: 10, cache_write: 0, cache_read: 0, output: 5 }));
  doc.sources.platform.costs = names.map((model, i) => ({ date: day(1), model, usd: i + 1 }));
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  for (const [i, n] of names.entries()) assert.match(p.app(), new RegExp(`<td>${n}</td><td>10</td><td>0</td><td>0</td><td>5</td><td>\\$${i + 1}\\.00</td>`), n);
  assert.match(p.app(), /\$6\.00/);
  assert.equal(p.store.get("gist"), A);
  assert.equal(vm.runInContext("({}).input", p.ctx), undefined, "Object.prototype untouched");
});

test("j: escaping works on its own: a VALID document with hostile strings renders no raw markup", async () => {
  const x = '"><img src=x onerror=globalThis.pwned=1>';
  const doc = validDoc();
  doc.host = x;
  doc.sources.claude.plan = x;
  doc.sources.claude.windows[0].label = x;
  doc.sources.codex.error = x;
  doc.sources.platform.usage[0].model = x;
  doc.sources.platform.costs[0].model = x;
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /malformed/);
  assert.ok(p.app().includes("&lt;img"), "strings reached the markup, escaped");
  assert.doesNotMatch(p.app(), /<img/);
  assert.doesNotMatch(p.app(), /"><img/);
});

test("k: numbers must be numbers: numeric strings and null are rejected", async () => {
  const paths = {
    "used_pct": (d, v) => (d.sources.claude.windows[0].used_pct = v),
    "period_seconds": (d, v) => (d.sources.claude.windows[0].period_seconds = v),
    "input": (d, v) => (d.sources.platform.usage[0].input = v),
    "usd": (d, v) => (d.sources.platform.costs[0].usd = v),
  };
  for (const [name, set] of Object.entries(paths)) for (const v of ["12", "", null, true]) {
    const doc = validDoc();
    set(doc, v);
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), new RegExp("malformed: .*" + name), `${name}=${JSON.stringify(v)}`);
    assert.equal(p.store.has("gist"), false);
  }
});

test("l: fetched_at must parse as a date", async () => {
  const doc = validDoc();
  doc.sources.codex.fetched_at = "not a date";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /malformed: sources\.codex\.fetched_at/);
  assert.equal(p.store.has("gist"), false);
});

test("m: impossible calendar dates are rejected", async () => {
  for (const d of ["2026-02-31", "2026-13-01", "2026-04-31"]) {
    const doc = validDoc();
    doc.sources.platform.usage[0].date = d;
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), /malformed: sources\.platform\.usage\[0\]\.date/, d);
  }
  const ok = validDoc();
  ok.sources.platform.usage[0].date = "2026-02-28";
  assert.doesNotMatch((await boot({ hash: "#" + A, gists: { [A]: ok } })).app(), /malformed/);
});

test("m2: dates at the edges of the 400-day window are accepted, one beyond is not", async () => {
  for (const [i, good] of [[398, true], [399, false], [-1, true], [-2, false]]) {
    const doc = validDoc();
    doc.sources.platform.costs[0].date = day(i);
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.equal(/malformed/.test(p.app()), !good, `day(${i})`);
  }
});

test("n: a saved id that is not a gist id is ignored and never fetched", async () => {
  for (const bad of ["../../evil?x=1", "x".repeat(25), "deadbeef"]) {
    const p = await boot({ saved: { gist: bad }, gists: {} });
    assert.equal(p.fetched.length, 0, bad);
    assert.match(p.app(), /Setup/);
  }
  const p = await boot({ hash: "#" + A, saved: { gist: "../../evil" }, gists: { [A]: validDoc() } });
  assert.doesNotMatch(p.app(), /different data source/);
  assert.deepEqual(p.fetched, ["https://api.github.com/gists/" + A]);
  assert.equal(p.store.get("gist"), A);
});

test("o: a stale response cannot replace newer data or save the wrong id", async () => {
  const slowA = deferred(), gists = { [A]: () => slowA.promise, [B]: () => Promise.resolve(resp(doc1("model-b"))) };
  const p = await boot({ hash: "#" + A, gists });
  await p.hash("#" + B); // B finishes first
  assert.match(p.app(), /model-b/);
  slowA.resolve(resp(doc1("model-a"))); // A arrives late
  await p.settle();
  assert.match(p.app(), /model-b/);
  assert.doesNotMatch(p.app(), /model-a/);
  assert.equal(p.store.get("gist"), B);
  assert.equal(p.els["#refresh"].disabled, false);
});

test("p: a failed adopt does not leave the old gist's data under the new id", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: doc1("model-a") } });
  assert.match(p.app(), /model-a/);
  await p.hash("#" + B); // B differs from the saved A and is a 404: chooser first
  assert.match(p.app(), /different data source/);
  p.els["#adopt"].handlers.click();
  await p.settle();
  assert.doesNotMatch(p.app(), /model-a/);
  assert.match(p.app(), /Could not load data/);
  assert.equal(p.store.get("gist"), A);
});

test("q: the chooser does not stick when the link changes to #demo", async () => {
  const p = await boot({ hash: "#" + B, saved: { gist: A }, gists: { [A]: validDoc(), [B]: validDoc() } });
  assert.match(p.app(), /different data source/);
  await p.hash("#demo");
  assert.match(p.app(), /sample-model-large/);
  assert.doesNotMatch(p.app(), /different data source/);
});
