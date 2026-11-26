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

test("pace: a weekly window paced from a manual reset shows its shortened period and where it starts", async () => {
  const doc = validDoc();
  // Started 2 h ago, resets in 6 h: 25% of the paced period has elapsed, not the 95% a full week would show.
  doc.sources.claude.windows.push({ id: "seven_day", label: "Week, all models", used_pct: 10, resets_at: iso(6 * 36e5), period_seconds: 8 * 3600, paced_from: iso(-2 * 36e5) });
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /25% of period elapsed since reset /);
  assert.match(p.app(), /15 pts under pace/);
  assert.doesNotMatch(p.app(), /12% of period elapsed since reset/); // the unpaced session window says nothing about a reset
});

test("pace: a paced_from that is not a date is rejected", async () => {
  const doc = validDoc();
  doc.sources.claude.windows[0].paced_from = "<b>soon</b>";
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.match(p.app(), /malformed: sources\.claude\.windows\[0\]\.paced_from/);
});

// Loop guards: the collector's loopStatus document (schema 1), invented numbers shaped like the real one.
const loopStatus = () => ({
  schema: 1, computed_at: iso(-5 * 6e4),
  week: { window_start: iso(-4 * 864e5), resets_at: iso(2 * 864e5 + 22 * 36e5) },
  session: { plan: "ultra", stop_pct: null, hold: false },
  guard: { ok: true, verdict: "pace_hold", why: "Your weekly usage is ahead of the pace line, so no evals start. They start again once the pace line catches up.", fits: 0, pace_hold: true, pace_probe: false, session_hold: false },
  pace: { source: "live", used_pct: 76, at: iso(-6e4), elapsed_pct: 58.23, line_pct: 46.587, stop_pct: 80, ahead: true, under_line_points: -29.413 },
  guard_pace: { source: "guard", used_pct: 74, at: iso(-4 * 36e5), elapsed_pct: 58.23, line_pct: 46.587, stop_pct: 80, ahead: true, under_line_points: -27.413 },
  loop: { eval_spent_points: 13.28, eval_pending_points: 0, eval_committed_points: 13.28, loop_jobs_points: 8.927, used_points: 22.2075, cap_points: 25, eval_cap_points: 16.07, room_points: 0, eval_runs: 89, fires: 89 },
  forecast: { as_of: iso(-5 * 6e4), open_subjects: 21, backlog_points: 26.03, catch_up_weeks: { central: null, fast: null, slow: null }, catch_up_date: { central: null, fast: null, slow: null },
    keep_up_points_per_week: 6.18, capacity_points_per_week: 0, eval_cap_points_per_week: 0, loop_jobs_points_per_week: 8.93, non_eval_points_per_week: 108.28, pace_hold_modeled: true, tasks: [] },
  forecast_error: null,
});
const loopDoc = (status = loopStatus(), extra = {}) => { const d = validDoc(); d.sources.loop = { ok: true, fetched_at: iso(-6e4), status, ...extra }; return d; };
const loopApp = async (doc) => (await boot({ hash: "#" + A, gists: { [A]: doc } })).app();

test("loop-a: the sample renders verdict, pace, 5-hour stop, spend, reset, forecast and footer", async () => {
  const app = await loopApp(loopDoc());
  assert.match(app, /<h2>Loop guards<\/h2>/);
  assert.match(app, /big crit">● Paused: ahead of pace<\/span>/);
  assert.match(app, /Your weekly usage is ahead of the pace line, so no evals start\. They start again once the pace line catches up\./);
  assert.match(app, /76% used, pace line 46\.6% \(80% stop × 58% of week gone\): <span class="pace warn">29\.4 points ahead<\/span>/);
  assert.match(app, /Live reading at /);
  assert.match(app, /Guard's reading: 74% at /);
  assert.match(app, /Off: the ultra plan has no 5-hour window/);
  assert.match(app, /Loop share booked<\/span><span class="big">≈22\.2%/);
  assert.match(app, /The guard books ≈22\.2% against the 25% share \(evals 13\.3 incl\. 0\.0 pending, scheduled jobs' whole week 8\.9\): a safety margin on every run, never more than the account meter, so room ≈0\.0%\./);
  assert.doesNotMatch(app, /Loop spend</);
  assert.match(app, /Project threads are not counted\./);
  assert.match(app, /Next weekly reset[\s\S]*in 2 d 22 h/);
  assert.match(app, /Not at current capacity/);
  assert.match(app, /Keep-up ≈6\.2 points\/week · eval capacity ≈0\.0 points\/week · non-eval use ≈108\.3 points\/week · open subjects 21/);
  assert.match(app, /Per-task points: see the project dashboard's routines table\./);
  assert.match(app, /Forecast as of /);
  assert.match(app, /Computed 5 min ago/);
  assert.doesNotMatch(app, /sub warn" style/);
});

test("loop-spend: the estimate leads, below the account total, with the guard's booked figure beside it", async () => {
  // Adam, 2026-11-24: "Loop spend is shown as higher than all usage" (booked 17.6 against an account at 13%).
  const st = loopStatus();
  st.pace = { ...st.pace, used_pct: 13, ahead: false };
  Object.assign(st.loop, { estimated_points: 8.84, eval_estimated_points: 4.29, improve_estimated_points: 3.63, loop_jobs_so_far_points: 0.92,
    eval_spent_points: 16.02, eval_committed_points: 13, loop_jobs_points: 4.63, used_points: 17.63, room_points: 7.37 });
  const app = await loopApp(loopDoc(st));
  assert.match(app, /Loop spend<\/span><span class="big">≈8\.8%<\/span>/);
  assert.match(app, /≈8\.8% of the week used since the weekly reset, of the loop's 25% share \(eval runs 4\.3, improve runs 3\.6, scheduled jobs so far 0\.9\); the whole account has used 13%\./);
  assert.match(app, /The guard books ≈17\.6% against the 25% share \(evals 13\.0 incl\. 0\.0 pending, scheduled jobs' whole week 4\.6\)/);
  assert.match(app, /style="width:35\.36%"/);
  const bad = loopStatus(); bad.loop.estimated_points = 5;
  assert.match(await loopApp(loopDoc(bad)), /malformed: sources\.loop\.status\.loop\.eval_estimated_points/);
});

test("loop-b: the section is hidden when the document has no loop source", async () => {
  assert.doesNotMatch(await loopApp(validDoc()), /Loop guards/);
});

test("loop-c: each verdict maps to its label and color", async () => {
  const want = { open: ["Open", "good"], refresh: ["One run allowed", "warn"], pace_probe: ["One run allowed", "warn"], pace_hold: ["Paused: ahead of pace", "crit"],
    session_hold: ["Paused: 5-hour limit", "crit"], cap_full: ["Paused: weekly share used", "crit"], error: ["Guard could not run", "crit"], "__proto__": ["Unknown", "crit"] };
  for (const [verdict, [label, cls]] of Object.entries(want)) {
    const st = loopStatus(); st.guard.verdict = verdict;
    const app = await loopApp(loopDoc(st));
    assert.match(app, new RegExp(`big ${cls}">. ${label}</span>`), verdict);
  }
});

test("loop-d: a forecast with dates shows the central date and range; tasks make a table; the error is a warning", async () => {
  const st = loopStatus();
  Object.assign(st.forecast, { catch_up_date: { central: iso(30 * 864e5), fast: iso(20 * 864e5), slow: iso(50 * 864e5) },
    tasks: [{ task: "<b>x</b>", in_loop: true, model: "m", fires_per_week: 3, points_per_week: 4.5 }] });
  st.forecast_error = "forecast <i>partial</i>";
  const app = await loopApp(loopDoc(st));
  assert.doesNotMatch(app, /Not at current capacity/);
  assert.match(app, /Catch-up<\/span><span class="big">[^<]+ \(.+ to .+\)<\/span>/);
  assert.match(app, /<td>&lt;b&gt;x&lt;\/b&gt;<\/td><td>4\.5<\/td>/);
  assert.doesNotMatch(app, /Per-task points/);
  assert.match(app, /▲ Forecast: forecast &lt;i&gt;partial&lt;\/i&gt;/);
  assert.doesNotMatch(app, /<b>x|<i>partial/);
});

test("loop-g: the pace-hold replay behind the eval capacity is explained, and a bad one is rejected", async () => {
  const st = loopStatus();
  st.forecast.capacity_points_per_week = 6.3;
  st.forecast.pace_replay = { weeks: 2, low_points: 4.55, high_points: 8.04, flat_points: 0, half_spent_by_hours: 16.6 };
  let app = await loopApp(loopDoc(st));
  assert.match(app, /eval capacity ≈6\.3 points\/week/);
  assert.match(app, /Eval capacity replays the pace hold over your last 2 weeks of real use: ≈4\.5 to 8\.0 points a week, where a flat weekly average would give ≈0\.0\. Evals get half of it within about 17 hours of the weekly reset\./);
  st.forecast.pace_replay = { weeks: 1, low_points: 5, high_points: 5, flat_points: 0, half_spent_by_hours: null };
  app = await loopApp(loopDoc(st));
  assert.match(app, /over your last 1 week of real use: ≈5\.0 points a week, where a flat weekly average would give ≈0\.0\.<\/div>/);
  st.forecast.pace_replay = { weeks: 2, low_points: "4", high_points: 8, flat_points: 0 };
  assert.match(await loopApp(loopDoc(st)), /malformed/);
  assert.doesNotMatch(await loopApp(loopDoc()), /replays the pace hold/);
});

test("loop-basis: the forecast names its basis window, switches between precomputed windows and remembers the choice", async () => {
  const st = loopStatus();
  const win = (days, keep, cap) => ({ ...structuredClone(st.forecast), basis_window_days: days, basis_meter_days: Math.min(days, 24), keep_up_points_per_week: keep, capacity_points_per_week: cap });
  st.forecast = { ...win(28, 9.7, 4.2), by_window: { 14: win(14, 9, 3.7), 28: win(28, 9.7, 4.2), 56: win(56, 9.7, 4.1) } };
  const p = await boot({ hash: "#" + A, gists: { [A]: loopDoc(st) } });
  let app = p.app();
  assert.match(app, /<button data-basis="14" aria-pressed="false">14 days<\/button><button data-basis="28" aria-pressed="true">28 days \(default\)<\/button><button data-basis="56" aria-pressed="false">56 days<\/button>/);
  assert.match(app, /Rates average the last 28 days of data \(the meter history covers 24\.0 of them\)\./);
  assert.match(app, /Keep-up ≈9\.7 points\/week · eval capacity ≈4\.2 points\/week/);
  p.ctx.listeners["doc:click"]({ target: { dataset: { basis: "14" } } });
  app = p.app();
  assert.match(app, /data-basis="14" aria-pressed="true"/);
  assert.match(app, /Rates average the last 14 days of data\.<\/div>/);
  assert.match(app, /Keep-up ≈9\.0 points\/week · eval capacity ≈3\.7 points\/week/);
  assert.equal(p.store.get("basis"), "14");
  // A remembered choice the document does not offer, or a hostile one, falls back to the default.
  for (const saved of ["7", "<b>14</b>"]) {
    const q = await boot({ hash: "#" + A, saved: { basis: saved }, gists: { [A]: loopDoc(st) } });
    assert.match(q.app(), /data-basis="28" aria-pressed="true"/);
  }
  const r = await boot({ hash: "#" + A, saved: { basis: "56" }, gists: { [A]: loopDoc(st) } });
  assert.match(r.app(), /Rates average the last 56 days of data \(the meter history covers 24\.0 of them\)/);
  // A status from before the basis window shows no selector and no basis line.
  assert.doesNotMatch(await loopApp(loopDoc()), /data-basis|Rates average/);
});

test("loop-basis-real: a real loop_status forecast with every window validates and each window renders", async () => {
  // Generated by skills-evals scripts/loop_status.py forecast_section from a real forecast; see collector/tests for the
  // collector's side (it once flattened these nested windows into strings).
  const real = JSON.parse(fs.readFileSync(new URL("./fixtures/loop-forecast-by-window.json", import.meta.url), "utf8"));
  const st = loopStatus();
  st.forecast = real;
  const p = await boot({ hash: "#" + A, gists: { [A]: loopDoc(st) } });
  assert.doesNotMatch(p.app(), /malformed/);
  for (const days of Object.keys(real.by_window)) {
    p.ctx.listeners["doc:click"]({ target: { dataset: { basis: days } } });
    const app = p.app();
    assert.doesNotMatch(app, /malformed|Could not load data/);
    assert.match(app, new RegExp(`data-basis="${days}" aria-pressed="true"`));
    assert.match(app, new RegExp(`Rates average the last ${days} days of data`));
    assert.match(app, /How the catch-up is worked out/);
  }
  assert.deepEqual(Object.keys(real.by_window), ["14", "28", "56"]);
});

test("loop-basis-bad: a malformed window is rejected", async () => {
  const st = loopStatus();
  st.forecast = { ...st.forecast, basis_window_days: 28, by_window: { 28: { ...structuredClone(st.forecast), basis_window_days: 14 } } };
  assert.match(await loopApp(loopDoc(st)), /malformed: sources\.loop\.status\.forecast\.by_window\.28\.basis_window_days/);
  st.forecast.by_window = { "<b>": structuredClone(st.forecast.by_window[28]) };
  assert.match(await loopApp(loopDoc(st)), /malformed: sources\.loop\.status\.forecast\.by_window/);
  st.forecast.by_window = { 28: { ...structuredClone(loopStatus().forecast), basis_window_days: 28, keep_up_points_per_week: "9" } };
  assert.match(await loopApp(loopDoc(st)), /malformed/);
  st.forecast.by_window = undefined;
  st.forecast.basis_window_days = "28";
  assert.match(await loopApp(loopDoc(st)), /malformed: sources\.loop\.status\.forecast\.basis_window_days/);
});

test("loop-h: the catch-up calculation is shown step by step, escaped, and a bad one is rejected", async () => {
  const st = loopStatus();
  st.forecast.calculation = { subjects: [{ kind: "skill", subject: "<b>s</b>", route: "keep", open_cells: 1, pairs: 4, points: 1.25 }], subjects_total: 3,
    backlog_points: { central: 12, low: 10, high: 20 }, backlog_pairs: 24, usd_per_point: 15.6, weekly_cap_points: 25, loop_jobs_points: 9,
    after_loop_jobs_points: 16, capacity_points: 6, capacity_basis: "pace_replay", keep_up_items: [{ item: "new skills", points: 1 }, { item: "re-checks", points: 1 }],
    keep_up_points: 2, room_points: 4, weeks_central: 3, start: iso(-6e4) };
  let app = await loopApp(loopDoc(st));
  assert.match(app, /<summary>How the catch-up is worked out<\/summary>/);
  assert.match(app, /Open subjects: <b>3<\/b>/);
  assert.match(app, /<td>&lt;b&gt;s&lt;\/b&gt;<\/td><td>skill<\/td><td>keep<\/td><td>1<\/td><td>4<\/td><td>1\.3<\/td>/);
  assert.match(app, /2 more not listed\./);
  assert.match(app, /≈12\.0 points<\/b> \(10\.0 to 20\.0\), 24 pairs/);
  assert.match(app, /weekly cap <b>25\.0<\/b> − loop jobs <b>9\.0<\/b> = <b>16\.0<\/b>, then the pace hold replayed over recent weeks of your real use: <b>6\.0 points a week/);
  assert.match(app, /new skills 1\.0 \+ re-checks 1\.0 = <b>2\.0 points a week/);
  assert.match(app, /<b>6\.0<\/b> − <b>2\.0<\/b> = <b>4\.0 points a week/);
  assert.match(app, /<b>12\.0<\/b> ÷ <b>4\.0<\/b> = <b>3\.0 weeks<\/b> from /);
  assert.doesNotMatch(app, /<b>s<\/b>/);
  st.forecast.calculation.loop_jobs_points = 30;
  assert.doesNotMatch(await loopApp(loopDoc(st)), /loop jobs <b>30/);
  st.forecast.calculation.capacity_basis = "stop_less_other";
  st.forecast.calculation.account_stop_points = 75;
  assert.match(await loopApp(loopDoc(st)), /then the 75% stop less your other use:/);
  st.forecast.calculation.room_points = -1;
  app = await loopApp(loopDoc(st));
  assert.match(app, /Room is -1\.0 points a week, so the backlog never clears at this capacity\./);
  st.forecast.calculation.backlog_points.central = 0;
  assert.match(await loopApp(loopDoc(st)), /Catch-up: nothing to clear: 0 weeks\./);
  st.forecast.calculation.subjects[0].points = "1";
  assert.match(await loopApp(loopDoc(st)), /malformed/);
  assert.doesNotMatch(await loopApp(loopDoc()), /How the catch-up is worked out/);
});

test("loop-e: under the line, a 5-hour stop with a hold, and a stale computation", async () => {
  const st = loopStatus();
  Object.assign(st.pace, { used_pct: 40, under_line_points: 6.5, ahead: false });
  st.guard_pace = null;
  st.session = { plan: "max", stop_pct: 90, hold: true };
  st.computed_at = iso(-25 * 6e4);
  const app = await loopApp(loopDoc(st));
  assert.match(app, /<span class="pace good">6\.5 points under<\/span>/);
  assert.doesNotMatch(app, /Guard's reading/);
  assert.match(app, /Stop at 90%[\s\S]*Holding/);
  assert.match(app, /class="sub warn" style="margin-top:10px">▲ Computed 25 min ago/);
});

test("loop-f: the guard error shape (no pace, loop, session, week or forecast) renders", async () => {
  const st = { schema: 1, computed_at: iso(-6e4), guard: { ok: false, verdict: "error", why: "state unreadable", fits: 0 } };
  const app = await loopApp(loopDoc(st));
  assert.match(app, /Guard could not run/);
  assert.match(app, /state unreadable/);
  assert.doesNotMatch(app, /Weekly pace|Loop spend|Next weekly reset|Forecast<|malformed/);
});

test("loop-g: a failed loop source keeps the previous status and shows the error; a wrong schema is rejected", async () => {
  const app = await loopApp(loopDoc(loopStatus(), { ok: false, error: "loop: status command failed (exit 1)" }));
  assert.match(app, /▲ loop: status command failed \(exit 1\)/);
  assert.match(app, /Paused: ahead of pace/);
  const st = loopStatus(); st.schema = 2;
  assert.match(await loopApp(loopDoc(st)), /usage\.json is malformed: sources\.loop\.status\.schema/);
  const bad = loopStatus(); bad.loop.used_points = "<img src=x>";
  assert.match(await loopApp(loopDoc(bad)), /malformed: sources\.loop\.status\.loop\.used_points/);
});

test("fmtTok: a count that rounds up to the next unit is promoted, never shown as 1000.0k", async () => {
  const doc = validDoc();
  doc.sources.platform.usage = [{ date: day(1), model: "example-model", input: 999950, cache_write: 999950000, cache_read: 999995000, output: 999 }];
  const p = await boot({ hash: "#" + A, gists: { [A]: doc } });
  assert.doesNotMatch(p.app(), /1000\.\d+[kMB]/);
  assert.match(p.app(), /<td>1\.0M<\/td><td>1\.00B<\/td><td>1\.00B<\/td><td>999<\/td>/);
});
