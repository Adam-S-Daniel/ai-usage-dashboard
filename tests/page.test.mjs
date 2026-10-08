import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

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
async function boot({ hash = "", saved = {}, gists = {}, failOn = null, wait = true } = {}) {
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
    addEventListener(t, f) { listeners[t] = f; }, setInterval() {}, console, Date: FakeDate, URL, atob, TextDecoder, crypto: globalThis.crypto,
    location: { hash, pathname: "/page", search: "" },
    history: { replaceState(_s, _t, url) { ctx.location.hash = ""; ctx.replaced = url; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url) => {
      fetched.push(url);
      const id = String(url).split("/").pop(), g = gists[id];
      if (typeof g === "function") return g(id);
      if (g === undefined) return { ok: false, status: 404 };
      const content = typeof g === "string" ? g : JSON.stringify(g);
      return new Response(JSON.stringify({ files: { "usage.json": { content } } }));
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  // WebCrypto resolves off the event loop, so wait for the load to finish; wait = false for a load a test holds pending.
  const settle = async (wait = true) => {
    for (let i = 0; i < 20 || (wait && els["#refresh"]?.disabled && i < 50000); i++) await new Promise((r) => setImmediate(r));
  };
  await settle(wait);
  return { ctx, els, fetched, store, app: () => els["#app"].innerHTML, settle, hash: async (h, w = true) => { ctx.location.hash = h; const r = ctx.listeners.hashchange(); if (w) await r; await settle(w); } };
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

const doc1 = (model, extra = {}) => { const d = validDoc(); d.sources.platform.usage[0].model = model; d.sources.platform.costs[0].model = model; return Object.assign(d, extra); };
const resp = (doc) => new Response(JSON.stringify({ files: { "usage.json": { content: JSON.stringify(doc) } } }));
const deferred = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };

test("r1-h: the crashing gist (year-0001 dates) is rejected, not saved, and the page is not blank", async () => {
  const doc = validDoc();
  doc.generated_at = "0001-06-01T00:00:00Z";
  doc.sources.platform.costs[0].date = "0001-01-01";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /malformed: generated_at/);
  assert.equal(p.store.has("gist"), false);
});

test("r1-h2: generated_at far in the future or the past is rejected", async () => {
  for (const g of [iso(3 * 864e5), iso(-6 * 365 * 864e5)]) {
    const doc = validDoc();
    doc.generated_at = g;
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), /malformed: generated_at/);
    assert.equal(p.store.has("gist"), false);
  }
});

test("r1-h3: the chart draws at most 400 days even when handed unvalidated years-old dates", async () => {
  const p = await boot();
  p.ctx.src = { ok: true, usage: [], costs: [{ date: "0001-01-01", model: "m", usd: 1 }, { date: day(0), model: "m", usd: 2 }] };
  const out = vm.runInContext("platformCard(src)", p.ctx);
  const hits = out.match(/class="hit"/g).length;
  assert.ok(hits >= 1 && hits <= 400, "hit rects: " + hits);
});

test("r1-h4: a render failure shows an error state and does not save the id", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: doc1("RENDER-BOOM") }, failOn: "RENDER-BOOM" });
  assert.equal(p.store.has("gist"), false);
  assert.match(p.app(), /Could not display the data: boom/);
  assert.equal(p.els["#updated"].textContent, "Error");
});

test("r1-i: model names like __proto__, constructor and toString each get their own row", async () => {
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

test("r1-j: escaping works on its own: a VALID document with hostile strings renders no raw markup", async () => {
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

test("r1-k: numbers must be numbers: numeric strings and null are rejected", async () => {
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

test("r1-l: fetched_at must parse as a date", async () => {
  const doc = validDoc();
  doc.sources.codex.fetched_at = "not a date";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /malformed: sources\.codex\.fetched_at/);
  assert.equal(p.store.has("gist"), false);
});

test("r1-m: impossible calendar dates are rejected", async () => {
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

test("r1-m2: dates at the edges of the 400-day window are accepted, one beyond is not", async () => {
  for (const [i, good] of [[398, true], [399, false], [-1, true], [-2, false]]) {
    const doc = validDoc();
    doc.sources.platform.costs[0].date = day(i);
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.equal(/malformed/.test(p.app()), !good, `day(${i})`);
  }
});

test("r1-n: a saved id that is not a gist id is ignored and never fetched", async () => {
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

test("r1-o: a stale response cannot replace newer data or save the wrong id", async () => {
  const slowA = deferred(), gists = { [A]: () => slowA.promise, [B]: () => Promise.resolve(resp(doc1("model-b"))) };
  const p = await boot({ hash: "#" + A, gists, wait: false });
  await p.hash("#" + B); // B finishes first
  assert.match(p.app(), /model-b/);
  slowA.resolve(resp(doc1("model-a"))); // A arrives late
  await p.settle();
  assert.match(p.app(), /model-b/);
  assert.doesNotMatch(p.app(), /model-a/);
  assert.equal(p.store.get("gist"), B);
  assert.equal(p.els["#refresh"].disabled, false);
});

test("r1-p: a failed adopt does not leave the old gist's data under the new id", async () => {
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

test("r1-q: the chooser does not stick when the link changes to #demo", async () => {
  const p = await boot({ hash: "#" + B, saved: { gist: A }, gists: { [A]: validDoc(), [B]: validDoc() } });
  assert.match(p.app(), /different data source/);
  await p.hash("#demo");
  assert.match(p.app(), /sample-model-large/);
  assert.doesNotMatch(p.app(), /different data source/);
});

// ---- second review round ----

const rawResp = (text) => new Response(text);
const truncatedResp = (rawUrl) => new Response(JSON.stringify({ files: { "usage.json": { truncated: true, raw_url: rawUrl } } }));
const RAW = "https://gist.githubusercontent.com/example/raw/";

test("r2-a: a truncated gist is read through raw_url; a stale raw response is ignored", async () => {
  const slowRaw = deferred();
  const gists = {
    [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => slowRaw.promise,
    [B]: () => Promise.resolve(truncatedResp(RAW + "rawB")), rawB: () => Promise.resolve(rawResp(JSON.stringify(doc1("model-b")))),
  };
  const p = await boot({ hash: "#" + A, gists, wait: false });
  await p.hash("#" + B);
  assert.match(p.app(), /model-b/);
  assert.equal(p.store.get("gist"), B);
  slowRaw.resolve(rawResp(JSON.stringify(doc1("model-a")))); // A's raw text arrives late
  await p.settle();
  assert.match(p.app(), /model-b/);
  assert.doesNotMatch(p.app(), /model-a/);
  assert.equal(p.store.get("gist"), B);
});

test("r2-a2: a truncated gist with a raw_url off gist.githubusercontent.com is refused", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(truncatedResp("https://example.com/raw")) } });
  assert.match(p.app(), /no usable download link/);
  assert.deepEqual(p.fetched, ["https://api.github.com/gists/" + A]);
});

test("r2-b: a late network failure from an older request does not show 'Refresh failed' over newer data", async () => {
  const slowFail = deferred(), gists = { [A]: () => slowFail.promise, [B]: () => Promise.resolve(resp(doc1("model-b"))) };
  const p = await boot({ hash: "#" + A, gists, wait: false });
  await p.hash("#" + B);
  assert.match(p.app(), /model-b/);
  slowFail.resolve(Promise.reject(new Error("Failed to fetch")));
  await p.settle();
  assert.match(p.app(), /model-b/);
  assert.doesNotMatch(p.app(), /Refresh failed|Failed to fetch/);
});

test("r2-c: crafted fragments are never fetched, saved or shown", async () => {
  const k = newKey();
  for (const h of ["#../../user", `#${A}/../x`, "#%2e%2e", `#${A}.${k}x`, `#${A}.${k.slice(1)}`, `#${A}..`, `#${A}.${k}.${k}`, `#${A}?x=1`, `#${A}%2f..`, `#${A}\n`]) {
    const p = await boot({ hash: h, gists: {} });
    assert.equal(p.fetched.length, 0, h);
    assert.equal(p.store.size, 0, h);
    assert.match(p.app(), /Setup/, h);
  }
  for (const bad of [`${A}.${k}x`, `${A}/../x`]) {
    const p = await boot({ saved: { gist: bad }, gists: {} });
    assert.equal(p.fetched.length, 0, bad);
  }
});

test("r2-d1: an oversized gist (5.5 MB of valid-looking JSON) is rejected with a clear error and small markup", async () => {
  const doc = validDoc();
  doc.sources.platform.usage = Array.from({ length: 60000 }, () => doc.sources.platform.usage[0]);
  const text = JSON.stringify(doc);
  assert.ok(text.length > 5e6);
  const p = await boot({ hash: "#" + A, gists: { [A]: text } });
  assert.match(p.app(), /missing or too large/);
  assert.ok(p.app().length < 2000);
  assert.equal(p.store.has("gist"), false);
});

test("r2-d2: an oversized encrypted envelope is rejected before decoding", async () => {
  const k = newKey(), env = JSON.stringify({ v: 1, enc: "A256GCM", iv: "A".repeat(16), ct: "A".repeat(4e6 + 10) });
  const p = await boot({ hash: `#${A}.${k}`, gists: { [A]: env } });
  assert.match(p.app(), /missing or too large/);
});

test("r2-d3: malformed iv/ct shapes fail as a decrypt error, never a crash or a key leak", async () => {
  const k = newKey();
  for (const bad of [{ iv: 123, ct: "AAAA" }, { iv: "AAAAAAAAAAAAAAAA", ct: ["x"] }, { iv: "!!!!", ct: "AAAA" }, { iv: "AAAAAAAAAAAAAAAA", ct: "" }, { iv: "AAAA", ct: "AAAA" }]) {
    const p = await boot({ hash: `#${A}.${k}`, gists: { [A]: { v: 1, enc: "A256GCM", ...bad } } });
    assert.match(p.app(), /Could not decrypt usage\.json/, JSON.stringify(bad));
    assert.equal(p.app().includes(k), false);
    assert.equal(p.els["#updated"].textContent.includes(k), false);
    assert.equal(p.store.has("gist"), false);
  }
});

test("r2-d4: JSON that does not parse gives a fixed message, not the parser's excerpt of the text", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: "{not json SECRET-EXCERPT" } });
  assert.match(p.app(), /usage\.json is not valid JSON/);
  assert.doesNotMatch(p.app(), /SECRET-EXCERPT/);
});

test("r2-d5: row, window, model and string counts are capped", async () => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const usage = (m) => ({ date: day(1), model: m, input: 1, cache_write: 0, cache_read: 0, output: 1 });
  const cases = [
    ["usage rows", (d, n) => (d.sources.platform.usage = rows(n, () => usage("m"))), 10000, /sources\.platform\.usage/],
    ["cost rows", (d, n) => (d.sources.platform.costs = rows(n, () => ({ date: day(1), model: "m", usd: 1 }))), 10000, /sources\.platform\.costs/],
    ["windows", (d, n) => (d.sources.claude.windows = rows(n, () => ({ label: "w", used_pct: 1, period_seconds: 60 }))), 20, /sources\.claude\.windows/],
    ["models", (d, n) => { d.sources.platform.costs = []; d.sources.platform.usage = rows(n, (i) => usage("m" + i)); }, 300, /sources\.platform\.models/],
    ["model length", (d, n) => (d.sources.platform.usage = [usage("m".repeat(n))]), 200, /usage\[0\]\.model/],
    ["label length", (d, n) => (d.sources.claude.windows[0].label = "l".repeat(n)), 200, /windows\[0\]\.label/],
    ["plan length", (d, n) => (d.sources.claude.plan = "p".repeat(n)), 200, /claude\.plan/],
    ["host length", (d, n) => (d.host = "h".repeat(n)), 200, /host/],
    ["error length", (d, n) => (d.sources.codex.error = "e".repeat(n)), 1000, /codex\.error/],
  ];
  for (const [name, set, max, re] of cases) {
    const ok = validDoc(); set(ok, max);
    const pOk = await boot({ hash: "#" + A, gists: { [A]: ok } });
    assert.doesNotMatch(pOk.app(), /malformed/, name + " at the cap");
    const over = validDoc(); set(over, max + 1);
    const pOver = await boot({ hash: "#" + A, gists: { [A]: over } });
    assert.match(pOver.app(), re, name + " over the cap");
    assert.match(pOver.app(), /malformed/);
    assert.equal(pOver.store.has("gist"), false);
  }
});

test("r2-e1: numbers are bounded, so sums cannot reach Infinity or NaN", async () => {
  for (const [path, set] of [["used_pct", (d) => (d.sources.claude.windows[0].used_pct = 1e16)], ["usd", (d) => (d.sources.platform.costs[0].usd = 1e16)],
    ["input", (d) => (d.sources.platform.usage[0].input = 1e16)], ["period_seconds", (d) => (d.sources.claude.windows[0].period_seconds = 1e300)]]) {
    const doc = validDoc(); set(doc);
    assert.match((await boot({ hash: "#" + A, gists: { [A]: doc } })).app(), new RegExp("malformed: .*" + path), path);
  }
  const doc = validDoc(), n = 5000;
  doc.sources.platform.usage = Array.from({ length: n }, () => ({ date: day(1), model: "big", input: 1e15, cache_write: 1e15, cache_read: 1e15, output: 1e15 }));
  doc.sources.platform.costs = Array.from({ length: n }, () => ({ date: day(1), model: "big", usd: 1e15 }));
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /malformed|Infinity|NaN/);
  assert.match(p.app(), /<td>big<\/td>/);
});

test("r2-e2: negative token counts and negative costs are rejected", async () => {
  for (const [path, set] of [["input", (d) => (d.sources.platform.usage[0].input = -1)], ["cache_write", (d) => (d.sources.platform.usage[0].cache_write = -1)],
    ["cache_read", (d) => (d.sources.platform.usage[0].cache_read = -1)], ["output", (d) => (d.sources.platform.usage[0].output = -1)],
    ["usd", (d) => (d.sources.platform.costs[0].usd = -0.01)]]) {
    const doc = validDoc(); set(doc);
    assert.match((await boot({ hash: "#" + A, gists: { [A]: doc } })).app(), new RegExp("malformed: .*" + path), path);
  }
});

test("r2-g1: an implausible date says the device clock may be wrong", async () => {
  const doc = validDoc();
  doc.generated_at = iso(30 * 864e5);
  assert.match((await boot({ hash: "#" + A, gists: { [A]: doc } })).app(), /generated_at is far from this device's date; the device clock may be wrong/);
  const old = validDoc();
  old.sources.platform.costs[0].date = day(500);
  assert.match((await boot({ hash: "#" + A, gists: { [A]: old } })).app(), /costs\[0\]\.date is far from this device's date; the device clock may be wrong/);
  const typo = validDoc();
  typo.sources.platform.costs[0].date = "yesterday";
  assert.doesNotMatch((await boot({ hash: "#" + A, gists: { [A]: typo } })).app(), /clock/);
});

test("r2-g2: after a failed adopt the next timed or visibility load keeps the error, not the chooser", async () => {
  const p = await boot({ hash: "#" + B, saved: { gist: A }, gists: { [A]: validDoc() } }); // B is a 404
  assert.match(p.app(), /different data source/);
  p.els["#adopt"].handlers.click();
  await p.settle();
  assert.match(p.app(), /Could not load data/);
  await p.ctx.listeners["doc:visibilitychange"]();
  await p.settle();
  assert.match(p.app(), /Could not load data/);
  assert.doesNotMatch(p.app(), /different data source/);
  assert.equal(p.store.get("gist"), A);
});

test("r2-g3: the rendered page is cleared when the source changes, so #demo does not linger under a real id", async () => {
  const slow = deferred(), p = await boot({ hash: "#demo", gists: { [A]: () => slow.promise } });
  assert.match(p.app(), /sample-model-large/);
  await p.hash("#" + A, false); // the fetch is still pending
  assert.doesNotMatch(p.app(), /sample-model/);
  assert.equal(p.els["#updated"].textContent, "Loading…");
  slow.resolve(resp(doc1("model-a")));
  await p.settle();
  assert.match(p.app(), /model-a/);
});

test("r2-g4: a timed reload of the same source keeps showing the data while it refetches", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: validDoc() } });
  const slow = deferred();
  p.ctx.fetch = () => slow.promise;
  const reload = p.ctx.listeners["doc:visibilitychange"]();
  assert.match(p.app(), /example-model/);
  slow.resolve({ ok: false, status: 500 });
  await reload;
  await p.settle();
  assert.match(p.app(), /Refresh failed: GitHub returned 500/);
  assert.match(p.app(), /example-model/);
});

// ---- review round 3 ----

const chunked = (chunks, headers = {}, state = {}) => {
  let i = 0;
  const body = new ReadableStream({
    pull(c) { if (i >= chunks.length) return c.close(); state.pulled = (state.pulled || 0) + chunks[i].length; c.enqueue(chunks[i++]); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }); // nothing is pulled until the page reads
  return new Response(body, { headers });
};
const mb = (n) => new Uint8Array(n * 1e6).fill(120); // "x" bytes

test("r3-1a: a document at the collector's maximum (300 days, 33 models, aggregated) is accepted", async () => {
  const doc = validDoc(), models = Array.from({ length: 33 }, (_, i) => "example-model-" + i), usage = [], costs = [];
  for (let d = 0; d < 300; d++) for (const m of models) {
    usage.push({ date: day(d), model: m, input: 123456789, cache_write: 123456, cache_read: 1234567890, output: 12345678 });
    costs.push({ date: day(d), model: m, usd: 12.3456789 });
  }
  doc.sources.platform.usage = usage; doc.sources.platform.costs = costs;
  assert.equal(usage.length, 9900);
  assert.ok(JSON.stringify(doc).length < 4e6);
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /malformed|too large/);
  assert.match(p.app(), /example-model-32/);
  assert.equal(p.store.get("gist"), A);
});

test("r3-1b: the older un-aggregated shape at 300 days (4 models x 5 cost lines a day) is still accepted", async () => {
  const doc = validDoc(), usage = [], costs = [];
  for (let d = 0; d < 300; d++) for (let m = 1; m <= 4; m++) {
    usage.push({ date: day(d), model: "example-model-" + m, input: 1, cache_write: 1, cache_read: 1, output: 1 });
    for (let c = 0; c < 5; c++) costs.push({ date: day(d), model: "example-model-" + m, usd: 0.5 });
  }
  doc.sources.platform.usage = usage; doc.sources.platform.costs = costs;
  assert.equal(costs.length, 6000);
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /malformed|too large/);
  assert.equal(p.store.get("gist"), A);
});

test("r3-2: validation runs on the DECRYPTED document: invalid fields are rejected, not rendered, not saved", async () => {
  const k = newKey();
  for (const [path, set] of [["input", (d) => (d.sources.platform.usage[0].input = "<img src=x onerror=globalThis.pwned=1>")],
    ["used_pct", (d) => (d.sources.claude.windows[0].used_pct = "50")], ["date", (d) => (d.sources.platform.costs[0].date = '2026-10-01"><img src=x>')]]) {
    const doc = validDoc(); set(doc);
    const p = await boot({ hash: `#${A}.${k}`, gists: { [A]: encrypt(doc, k) } });
    assert.match(p.app(), new RegExp("usage\\.json is malformed: .*" + path), path);
    assert.doesNotMatch(p.app(), /<img/);
    assert.doesNotMatch(p.app(), /example-model/);
    assert.equal(p.store.has("gist"), false);
  }
});

test("r3-3a: a raw_url body over the cap is refused by its content-length header without being read", async () => {
  const st = {};
  const gists = { [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => Promise.resolve(chunked([mb(1)], { "content-length": "9000000" }, st)) };
  const p = await boot({ hash: "#" + A, gists });
  assert.match(p.app(), /missing or too large/);
  assert.equal(st.pulled ?? 0, 0);
  assert.equal(p.store.has("gist"), false);
});

test("r3-3b: with no content-length the raw_url body is cut off at the cap while reading", async () => {
  const st = {}, chunks = Array.from({ length: 50 }, () => mb(1)); // 50 MB offered
  const gists = { [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => Promise.resolve(chunked(chunks, {}, st)) };
  const p = await boot({ hash: "#" + A, gists });
  assert.match(p.app(), /missing or too large/);
  assert.ok(st.pulled <= 8e6, "pulled " + st.pulled);
  assert.equal(st.cancelled, true);
  assert.equal(p.store.has("gist"), false);
});

test("r3-3c: a content-length that understates the body does not help", async () => {
  const st = {}, chunks = Array.from({ length: 50 }, () => mb(1));
  const gists = { [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => Promise.resolve(chunked(chunks, { "content-length": "100" }, st)) };
  const p = await boot({ hash: "#" + A, gists });
  assert.match(p.app(), /missing or too large/);
  assert.ok(st.pulled <= 8e6, "pulled " + st.pulled);
});

test("r3-3d: the gist API response is read with a byte limit too", async () => {
  const st = {}, chunks = Array.from({ length: 60 }, () => mb(1));
  const p = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(chunked(chunks, {}, st)) } });
  assert.match(p.app(), /missing or too large/);
  assert.ok(st.pulled <= 12e6, "pulled " + st.pulled);
  assert.equal(st.cancelled, true);
});

test("r3-3e: multi-byte text split inside a character across chunks decodes without replacement characters", async () => {
  const doc = doc1("modèl-é-日本"), bytes = new TextEncoder().encode(JSON.stringify({ files: { "usage.json": { content: JSON.stringify(doc) } } }));
  const cut = bytes.indexOf(0xe6) + 1; // after the first byte of 日 (E6 97 A5)
  assert.ok(cut > 0 && bytes[cut] === 0x97);
  const p = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(chunked([bytes.slice(0, cut), bytes.slice(cut)])) } });
  assert.match(p.app(), /modèl-é-日本/);
  assert.doesNotMatch(p.app(), /\uFFFD/);
});

// A response with no body stream (the text() fallback).
const noStream = (text, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => text });

test("r3-3f: without a body stream the text() fallback is used and still enforces the cap", async () => {
  const small = JSON.stringify({ files: { "usage.json": { content: JSON.stringify(doc1("fallback-model")) } } });
  const p = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(noStream(small)) } });
  assert.match(p.app(), /fallback-model/);
  const big = JSON.stringify({ files: { "usage.json": { truncated: true, raw_url: RAW + "rawA" }, pad: { content: "x".repeat(11e6) } } });
  const q = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(noStream(big)) } });
  assert.match(q.app(), /missing or too large/);
  const gists = { [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => Promise.resolve(noStream("x".repeat(4e6 + 1))) };
  const r = await boot({ hash: "#" + A, gists });
  assert.match(r.app(), /missing or too large/);
  assert.equal(r.store.has("gist"), false);
});

test("r4-5: an API response that is not JSON has its own message", async () => {
  const p = await boot({ hash: "#" + A, gists: { [A]: () => Promise.resolve(new Response("<html>rate limited</html>")) } });
  assert.match(p.app(), /The GitHub response is not valid JSON/);
  assert.doesNotMatch(p.app(), /usage\.json is not valid JSON/);
  assert.doesNotMatch(p.app(), /rate limited/);
});

test("r3-5a: a failing raw_url download shows an error and saves nothing", async () => {
  const gists = { [A]: () => Promise.resolve(truncatedResp(RAW + "rawA")), rawA: () => Promise.resolve(new Response("nope", { status: 500 })) };
  const p = await boot({ hash: "#" + A, gists });
  assert.match(p.app(), /Could not load data/);
  assert.match(p.app(), /GitHub returned 500/);
  assert.equal(p.store.has("gist"), false);
});

test("r3-5b: the same gist id with a different key is worded as a different key, not a different source", async () => {
  const k1 = newKey(), k2 = newKey();
  const p = await boot({ hash: `#${A}.${k1}`, saved: { gist: `${A}.${k2}` }, gists: {} });
  assert.match(p.app(), /Different key/);
  assert.match(p.app(), /same data source/);
  assert.doesNotMatch(p.app(), /different data source/);
  assert.equal(p.app().includes(k1) || p.app().includes(k2), false);
  assert.equal(p.fetched.length, 0);
});

test("r4-1: the real collector pipeline at its maximum (300 days x 33 models) publishes an envelope the page accepts", async (t) => {
  const key = newKey(), psm1 = fileURLToPath(new URL("../collector/AiUsage.psm1", import.meta.url));
  const script = `
    Import-Module $env:T_MODULE -Force
    $now = [datetimeoffset]'2026-10-04T12:00:00Z'
    $b = foreach ($d in 0..299) { $day = ([datetime]'2026-10-04').AddDays(-$d).ToString('yyyy-MM-ddT00:00:00Z')
      $u = foreach ($m in 1..33) { @{ model = "example-model-$m"; uncached_input_tokens = 123456789; cache_creation_input_tokens = 123456; cache_read_input_tokens = 1234567890; output_tokens = 12345678 } }
      $c = foreach ($m in 1..33) { foreach ($l in 1..2) { @{ model = "example-model-$m"; amount = '617.28395'; description = "line $l" } } }
      @{ u = @{ starting_at = $day; results = @($u) }; c = @{ starting_at = $day; results = @($c) } } }
    $up = @{ data = @($b | % { $_.u }) } | ConvertTo-Json -Depth 6 -Compress | ConvertFrom-Json; $cp = @{ data = @($b | % { $_.c }) } | ConvertTo-Json -Depth 6 -Compress | ConvertFrom-Json
    $platform = ConvertTo-PlatformSource -UsagePages @($up) -CostPages @($cp) -Now $now
    $sources = [ordered]@{ platform = $platform }
    (New-PublishPayload -Sources $sources -Now $now -Key $env:T_KEY).text`;
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 1e8, env: { ...process.env, T_MODULE: psm1, T_KEY: key } });
  if (r.error?.code === "ENOENT") return t.skip("pwsh is not on PATH");
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout.trim();
  assert.ok(Buffer.byteLength(text) < 3e6, "envelope bytes " + Buffer.byteLength(text));
  const p = await boot({ hash: `#${A}.${key}`, gists: { [A]: text } });
  assert.doesNotMatch(p.app(), /malformed|too large|Could not/);
  assert.match(p.app(), /example-model-33/);
  assert.equal(p.store.get("gist"), `${A}.${key}`);
});

test("other: codename limits validate when present and when absent, and bad entries are rejected", async () => {
  const entry = () => ({ id: "iguana_necktie", label: "iguana_necktie", used_pct: 100, resets_at: iso(36e5), limit_usd: 250, used_usd: 250.29, remaining_usd: 0, locked_reason: null });
  const withOther = validDoc();
  withOther.sources.claude.other = [entry(), { ...entry(), id: "x", label: "x", limit_usd: null, used_usd: null, remaining_usd: null, resets_at: null }];
  const ok = await boot({ hash: "#" + A, gists: { [A]: withOther } });
  assert.doesNotMatch(ok.app(), /malformed/);
  assert.match(ok.app(), /Other limits \(codenames\)/);
  assert.match(ok.app(), /<code>iguana_necktie<\/code>/);
  assert.match(ok.app(), /\$250\.29 of \$250\.00 \(\$0\.00 left\)/);
  const without = await boot({ hash: "#" + A, gists: { [A]: validDoc() } });
  assert.doesNotMatch(without.app(), /malformed|Other limits/);
  const bads = [
    ["used_pct", (e) => (e.used_pct = "100")],
    ["label", (e) => (e.label = "l".repeat(201))],
    ["limit_usd", (e) => (e.limit_usd = "250")],
    ["resets_at", (e) => (e.resets_at = "not a date")],
    ["locked_reason", (e) => (e.locked_reason = 5)],
  ];
  for (const [name, mutate] of bads) {
    const doc = validDoc(), e = entry();
    mutate(e);
    doc.sources.claude.other = [e];
    const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
    assert.match(p.app(), new RegExp("malformed: .*other\\[0\\]\\." + name), name);
    assert.equal(p.store.has("gist"), false);
  }
  const many = validDoc();
  many.sources.claude.other = Array.from({ length: 41 }, entry);
  assert.match((await boot({ hash: "#" + A, gists: { [A]: many } })).app(), /malformed: .*claude\.other/);
});

test("other: a hostile codename label is rendered as text", async () => {
  const x = "<img src=x onerror=alert(1)>";
  const doc = validDoc();
  doc.sources.claude.other = [{ id: x, label: x, used_pct: 5, resets_at: null, limit_usd: null, used_usd: null, remaining_usd: null, locked_reason: x }];
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /malformed/);
  assert.ok(p.app().includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.doesNotMatch(p.app(), /<img/);
});
