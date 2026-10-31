const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Translator, DEFAULTS, makeRequest, normalizeConfig, parseTranslation, retryAfter } = require("../src/core.cjs");
const config = extra => ({ ...DEFAULTS, deeplKey: "test-deepl", ...extra });
const response = (status, data = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => data, headers: { get: key => headers[key] } });
const deepl = texts => response(200, { translations: texts.map(text => ({ text })) });
const llm = (provider, texts) => {
    const text = JSON.stringify({ translations: texts.map((text, id) => ({ id, text })).reverse() });
    return provider === "openai"
        ? response(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] })
        : response(200, { choices: [{ finish_reason: "stop", message: { content: text } }] });
};
function harness(fetch) {
    let clock = 0;
    const waits = [];
    return { engine: new Translator({ fetch, now: () => clock, random: () => 0, sleep: async ms => { waits.push(ms); clock += ms; } }), waits, advance: ms => { clock += ms; } };
}

const rotationConfig = extra => config({ providerRotation: true, openaiKey: "o", openaiModel: "oa",
    deepseekKey: "d", deepseekModel: "ds", geminiKey: "g", geminiModel: "gm", openrouterKey: "r", openrouterModel: "or", ...extra });
function requestProvider(url) {
    return url.includes("deepl") ? "deepl" : url.includes("openai") ? "openai" : url.includes("deepseek") ? "deepseek" : url.includes("googleapis") ? "gemini" : "openrouter";
}
function rotationResponse(provider) {
    return provider === "deepl" ? deepl(["ok"]) : provider === "gemini" ? geminiResponse(["ok"]) : llm(provider, ["ok"]);
}

test("provider rotation visits all five configured services and wraps without advancing on cache hits", async () => {
    const calls = [];
    const { engine, advance } = harness(async url => { const provider = requestProvider(url); calls.push(provider); return rotationResponse(provider); });
    const c = rotationConfig({ provider: "gemini" });
    for (let i = 0; i < 6; i++) {
        await engine.translate(`text${i}`, c);
        await engine.translate(`text${i}`, c);
        advance(3000);
    }
    assert.deepEqual(calls, ["gemini", "deepl", "openai", "deepseek", "openrouter", "gemini"]);
    engine.dispose();
});

test("provider rotation OFF preserves selected-provider priority", async () => {
    const calls = [];
    const { engine, advance } = harness(async url => { calls.push(requestProvider(url)); return deepl(["ok"]); });
    const c = rotationConfig({ providerRotation: false });
    for (const text of ["one", "two", "three"]) { await engine.translate(text, c); advance(3000); }
    assert.deepEqual(calls, ["deepl", "deepl", "deepl"]);
    assert.equal(DEFAULTS.providerRotation, false);
    engine.dispose();
});

test("provider rotation works with API and model rotation OFF, ignoring backup keys and incomplete providers", async () => {
    const calls = [];
    const { engine, advance } = harness(async (url, options) => {
        const provider = requestProvider(url); calls.push([provider, JSON.parse(options.body).model]);
        assert.ok(!String(options.headers.Authorization).includes("unused"));
        return rotationResponse(provider);
    });
    const c = rotationConfig({ autoSwitch: false, modelRotation: false, openaiBackupKeys: ["unused"], openaiBackupModels: "unused",
        deepseekModel: "", geminiKey: "", openrouterKey: "" });
    for (const text of ["one", "two", "three", "four"]) { await engine.translate(text, c); advance(3000); }
    assert.deepEqual(calls, [["deepl", undefined], ["openai", "oa"], ["deepl", undefined], ["openai", "oa"]]);
    engine.dispose();
});

test("provider rotation skips blocked and cooling providers, preserving Retry-After across batches", async () => {
    const calls = [];
    const { engine, advance } = harness(async url => {
        const provider = requestProvider(url); calls.push(provider);
        return provider === "deepl" ? response(429, {}, { "Retry-After": "90" }) : provider === "openai" ? response(401) : rotationResponse(provider);
    });
    const c = rotationConfig({ geminiKey: "", openrouterKey: "" });
    await engine.translate("one", c);
    advance(3000); await engine.translate("two", c);
    assert.deepEqual(calls, ["deepl", "openai", "deepseek", "deepseek"]);
    advance(90000); await engine.translate("three", c);
    assert.deepEqual(calls.slice(4), ["deepl", "deepseek"]);
    engine.dispose();
});

test("provider rotation retains each service's model cursor", async () => {
    const calls = [];
    const { engine, advance } = harness(async (url, options) => {
        const provider = requestProvider(url); calls.push([provider, JSON.parse(options.body).model]); return rotationResponse(provider);
    });
    const c = rotationConfig({ provider: "openai", deeplKey: "", geminiKey: "", openrouterKey: "", openaiBackupModels: "ob", deepseekBackupModels: "db" });
    for (const text of ["one", "two", "three", "four"]) { await engine.translate(text, c); advance(3000); }
    assert.deepEqual(calls, [["openai", "oa"], ["deepseek", "ds"], ["openai", "ob"], ["deepseek", "db"]]);
    engine.dispose();
});

test("cancelled jobs do not consume a provider turn and disposal stops failover", async () => {
    const calls = [];
    const { engine } = harness(async url => { calls.push(requestProvider(url)); engine.dispose(); return response(503); });
    const c = rotationConfig();
    await assert.rejects(engine.translate("hidden", c, () => {}, { shouldSend: () => false }), /表示範囲外/);
    assert.equal(engine.providerCursor.size, 0);
    await assert.rejects(engine.translate("visible", c), /停止/);
    assert.deepEqual(calls, ["deepl"]);
});

test("DeepL uses array payload, free/pro endpoints and auto detection", () => {
    const free = makeRequest(["a", "b"], normalizeConfig(config()));
    assert.deepEqual(free.body.text, ["a", "b"]);
    assert.equal(free.body.source_lang, undefined);
    assert.equal(free.headers.Authorization, "DeepL-Auth-Key test-deepl");
    assert.match(free.url, /api-free/);
    const pro = makeRequest(["a"], normalizeConfig(config({ deeplPlan: "pro", source: "en" })));
    assert.equal(pro.body.source_lang, "EN"); assert.match(pro.url, /api\.deepl/);
});

test("OpenAI uses Responses API JSON mode; DeepSeek uses chat JSON mode", async () => {
    for (const provider of ["openai", "deepseek"]) {
        const request = makeRequest(["one", "two"], normalizeConfig(config({ provider, [`${provider}Key`]: "key", [`${provider}Model`]: "model" })));
        const input = provider === "openai" ? request.body.input : request.body.messages[1].content;
        assert.deepEqual(JSON.parse(input).items, [{ id: 0, text: "one" }, { id: 1, text: "two" }]);
        if (provider === "openai") {
            assert.match(request.url, /\/responses$/); assert.equal(request.body.store, false);
            assert.equal(request.body.text.format.type, "json_object");
        } else assert.equal(request.body.response_format.type, "json_object");
        assert.deepEqual(parseTranslation(await llm(provider, ["一", "二"]).json(), provider, 2), ["一", "二"]);
    }
});

test("burst calls coalesce; duplicate calls and cache do not spend extra requests", async () => {
    const requests = [];
    const { engine } = harness(async (url, options) => { const body = JSON.parse(options.body); requests.push(body); return deepl(body.text.map(x => `訳:${x}`)); });
    const c = config();
    const values = await Promise.all([engine.translate("a", c), engine.translate("b", c), engine.translate("a", c)]);
    assert.deepEqual(values, ["訳:a", "訳:b", "訳:a"]);
    assert.equal(requests.length, 1); assert.deepEqual(requests[0].text, ["a", "b"]);
    assert.equal(await engine.translate("a", c), "訳:a"); assert.equal(requests.length, 1);
    engine.dispose();
});

test("10 items use 2 requests, bounded to 8 per request", async () => {
    const sizes = [];
    const { engine, waits } = harness(async (url, options) => { const texts = JSON.parse(options.body).text; sizes.push(texts.length); return deepl(texts); });
    const texts = Array.from({ length: 10 }, (_, i) => `text${i}`);
    assert.deepEqual(await engine.translateMany(texts, config()), texts);
    assert.deepEqual(sizes, [8, 2]); assert.ok(waits.includes(3000));
    engine.dispose();
});

test("different target or keys never share a batch; 6000 character budget is enforced", async () => {
    const bodies = [];
    const { engine } = harness(async (url, options) => { const body = JSON.parse(options.body); bodies.push(body); return deepl(body.text); });
    await Promise.all([
        engine.translate("a".repeat(4000), config()), engine.translate("b".repeat(4000), config()),
        engine.translate("c", config({ target: "FR" })), engine.translate("d", config({ deeplKey: "other" })),
    ]);
    assert.equal(bodies.length, 4); assert.ok(bodies.every(b => b.text.join("").length <= 6000));
    engine.dispose();
});

test("429 immediately switches to backup key; cooldown is remembered for the next batch", async () => {
    const keys = [];
    const { engine } = harness(async (url, options) => {
        keys.push(options.headers.Authorization);
        return keys.length === 1 ? response(429, {}, { "Retry-After": "90" }) : deepl(JSON.parse(options.body).text);
    });
    const c = config({ deeplBackupKeys: ["backup"] });
    assert.deepEqual(await engine.translateMany(["a", "b"], c), ["a", "b"]);
    await engine.translate("c", c);
    assert.deepEqual(keys, ["DeepL-Auth-Key test-deepl", "DeepL-Auth-Key backup", "DeepL-Auth-Key backup"]);
    engine.dispose();
});

test("529 switches provider without splitting the JSON batch, preserving item order", async () => {
    const urls = [], statuses = [];
    const { engine } = harness(async (url, options) => {
        urls.push(url);
        if (url.includes("deepl")) return response(529);
        const body = JSON.parse(options.body);
        assert.equal(JSON.parse(body.input).items.length, 2);
        return llm("openai", ["one", "two"]);
    });
    assert.deepEqual(await engine.translateMany(["first", "second"], config({ openaiKey: "o", openaiModel: "m" }), status => statuses.push(status)), ["one", "two"]);
    assert.equal(urls.length, 2); assert.match(urls[1], /openai/); assert.ok(statuses.some(x => x.includes("529")));
    engine.dispose();
});

test("same credential cooldown applies even if another provider is selected first", async () => {
    const calls = [];
    const { engine } = harness(async (url, options) => {
        calls.push(url);
        if (url.includes("deepl")) return response(429, {}, { "Retry-After": "100" });
        return llm("deepseek", ["ok"]);
    });
    const c = config({ deepseekKey: "d", deepseekModel: "m" });
    await engine.translate("one", c);
    await engine.translate("two", { ...c, provider: "deepseek" });
    assert.equal(calls.filter(x => x.includes("deepl")).length, 1);
    engine.dispose();
});

test("auto switch OFF stays on the primary key and honors Retry-After", async () => {
    let count = 0;
    const { engine, waits } = harness(async (url, options) => {
        assert.match(url, /deepl/); assert.equal(options.headers.Authorization, "DeepL-Auth-Key test-deepl");
        return ++count === 1 ? response(429, {}, { "Retry-After": "8" }) : deepl(["ok"]);
    });
    assert.equal(await engine.translate("x", config({ autoSwitch: false, deeplBackupKeys: ["unused"], openaiKey: "unused", openaiModel: "m" })), "ok");
    assert.ok(waits.includes(8000)); assert.equal(count, 2); engine.dispose();
});

test("all failing credentials stop within bounded attempts, without automatic fan-out", async () => {
    let count = 0, inFlight = 0, max = 0;
    const { engine, waits } = harness(async () => { count++; inFlight++; max = Math.max(max, inFlight); await Promise.resolve(); inFlight--; return response(529); });
    await assert.rejects(engine.translate("x", config({ deeplBackupKeys: ["b", "c", "d"] })), /登録済み API/);
    assert.equal(count, 4); assert.equal(max, 1); assert.deepEqual(waits, [350]); engine.dispose();
});

test("auth and quota failures exclude credentials; 400 is not retried", async () => {
    for (const status of [401, 403, 402, 456]) {
        let count = 0;
        const { engine } = harness(async () => { count++; return count === 1 ? response(status) : deepl(["ok"]); });
        await engine.translate("x", config({ deeplBackupKeys: ["b"] }));
        assert.equal(engine.blocked.size, 1); assert.equal(count, 2); engine.dispose();
    }
    let count = 0;
    const { engine } = harness(async () => { count++; return response(400); });
    await assert.rejects(engine.translate("x", config()), /HTTP 400/); assert.equal(count, 1); engine.dispose();
});

test("refuses missing, duplicate or foreign IDs and truncated LLM output", () => {
    for (const translations of [[{ id: 0, text: "a" }], [{ id: 0, text: "a" }, { id: 0, text: "b" }], [{ id: 0, text: "a" }, { id: 5, text: "b" }]]) {
        assert.throws(() => parseTranslation({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations }) } }] }, "deepseek", 2), /ID/);
    }
    assert.throws(() => parseTranslation({ choices: [{ finish_reason: "length" }] }, "deepseek"), /途中/);
    assert.throws(() => parseTranslation({ status: "incomplete" }, "openai"), /完了/);
    assert.throws(() => parseTranslation({ translations: [{ text: "a" }] }, "deepl", 2), /件数/);
});

test("cache expires, separates accounts, and explicit clearing works", async () => {
    let count = 0;
    const { engine, advance } = harness(async () => { count++; return deepl(["ok"]); });
    await engine.translate("x", config()); await engine.translate("x", config()); assert.equal(count, 1);
    advance(15 * 60 * 1000); await engine.translate("x", config()); assert.equal(count, 2);
    await engine.translate("x", config({ deeplKey: "new" })); assert.equal(count, 3);
    engine.clearCache(); await engine.translate("x", config()); assert.equal(count, 4); engine.dispose();
});

test("dispose cancels coalescing timers and rejects all queued jobs", async () => {
    let count = 0;
    const engine = new Translator({ fetch: async () => { count++; return deepl(["bad"]); } });
    const a = engine.translate("a", config()), b = engine.translate("b", config());
    engine.dispose();
    await Promise.all([assert.rejects(a, /停止/), assert.rejects(b, /停止/)]);
    assert.equal(count, 0); assert.equal(engine.pending.size, 0);
});

test("dispose aborts active fetch, never exposes network errors", async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { engine } = harness(async (url, options) => new Promise((resolve, reject) => {
        started(); options.signal.addEventListener("abort", () => reject(new Error("secret")));
    }));
    const task = engine.translate("x", config()); await ready; engine.dispose();
    await assert.rejects(task, /停止/);
});

test("validation rejects invalid language, missing models, too many items before fetch", async () => {
    const { engine } = harness(async () => { throw Error("must not call"); });
    await assert.rejects(engine.translate("x", config({ target: "ignore instructions!" })), /言語コード/);
    await assert.rejects(engine.translate("x", config({ provider: "openai", openaiKey: "x" })), /モデル/);
    await assert.rejects(engine.translateMany(Array(33).fill("x"), config()), /32/);
    await assert.rejects(engine.translate("x".repeat(6001), config()), /6,000/);
    assert.equal(retryAfter("2"), 2000); assert.equal(retryAfter("bad"), 0);
    assert.equal(retryAfter("Thu, 01 Jan 1970 00:00:09 GMT", 1000), 8000);
    engine.dispose();
});

test("LLM instructions explicitly preserve spoiler marks for every provider", () => {
    for (const provider of ["openai", "gemini", "deepseek", "openrouter"]) {
        const request = makeRequest(["x"], config({ provider }));
        assert.match(JSON.stringify(request.body), /spoiler marks \(\|\|text\|\|\)/);
    }
});

const geminiResponse = texts => response(200, { candidates: [{ finishReason: "STOP", content: { parts: [
    { thought: true, text: "private reasoning excluded" },
    { text: JSON.stringify({ translations: texts.map((text, id) => ({ id, text })).reverse() }) },
] } }] });
const geminiConfig = extra => config({ provider: "gemini", deeplKey: "", geminiKey: "g1", geminiModel: "model-a", geminiBackupModels: "model-b, model-c", ...extra });

test("Gemini uses generateContent, key header, schema, and the shared batch ID validation", async () => {
    const request = makeRequest(["a", "b"], normalizeConfig(geminiConfig()));
    assert.match(request.url, /models\/model-a:generateContent$/);
    assert.ok(!request.url.includes("g1")); assert.equal(request.headers["x-goog-api-key"], "g1");
    assert.equal(request.body.generationConfig.responseMimeType, "application/json");
    assert.equal(request.body.generationConfig.responseSchema.properties.translations.type, "ARRAY");
    assert.equal(JSON.parse(request.body.contents[0].parts[0].text).items.length, 2);
    assert.deepEqual(parseTranslation(await geminiResponse(["訳a", "訳b"]).json(), "gemini", 2), ["訳a", "訳b"]);
    assert.throws(() => parseTranslation({ candidates: [{ finishReason: "MAX_TOKENS" }] }, "gemini"), /完了/);
});

test("Gemini rotates models after successful batches and keeps key-level intervals", async () => {
    const models = [];
    const { engine, waits } = harness(async (url) => { models.push(url.match(/models\/(.*):/)[1]); return geminiResponse(["ok"]); });
    const c = geminiConfig({ autoSwitch: false });
    for (const text of ["one", "two", "three", "four"]) await engine.translate(text, c);
    assert.deepEqual(models, ["model-a", "model-b", "model-c", "model-a"]);
    assert.equal(waits.filter(ms => ms === 2650).length, 3);
    engine.dispose();
});

test("Gemini 429 rotates model on the same key and respects server RetryInfo", async () => {
    const calls = [];
    const { engine } = harness(async (url, options) => {
        calls.push([url.match(/models\/(.*):/)[1], options.headers["x-goog-api-key"]]);
        return calls.length === 1 ? response(429, { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }] } }) : geminiResponse(["ok"]);
    });
    const c = geminiConfig({ autoSwitch: false });
    await engine.translate("one", c); await engine.translate("two", c); await engine.translate("three", c);
    assert.deepEqual(calls, [["model-a", "g1"], ["model-b", "g1"], ["model-c", "g1"], ["model-b", "g1"]]);
    engine.dispose();
});

test("Gemini can rotate both models and API keys; 529 skips the affected pair", async () => {
    const calls = [];
    const { engine } = harness(async (url, options) => {
        calls.push([url.match(/models\/(.*):/)[1], options.headers["x-goog-api-key"]]);
        return calls.length === 1 ? response(529) : geminiResponse(["ok"]);
    });
    const c = geminiConfig({ geminiBackupKeys: ["g2"] });
    await engine.translate("one", c); await engine.translate("two", c);
    assert.deepEqual(calls, [["model-a", "g1"], ["model-a", "g2"], ["model-b", "g1"]]);
    engine.dispose();
});

test("Gemini unavailable model is excluded, but does not exclude other models of that key", async () => {
    const models = [];
    const { engine } = harness(async url => { const model = url.match(/models\/(.*):/)[1]; models.push(model); return model === "model-a" ? response(404) : geminiResponse(["ok"]); });
    await engine.translate("x", geminiConfig({ autoSwitch: false }));
    assert.deepEqual(models, ["model-a", "model-b"]); assert.equal(engine.blocked.size, 0);
    assert.equal(engine.blockedModels.size, 1); engine.dispose();
});

test("model rotation can be disabled independently of API failover", async () => {
    const calls = [];
    const { engine } = harness(async (url, options) => {
        calls.push([url.match(/models\/(.*):/)[1], options.headers["x-goog-api-key"]]);
        return calls.length === 1 ? response(429) : geminiResponse(["ok"]);
    });
    await engine.translate("x", geminiConfig({ modelRotation: false, geminiBackupKeys: ["g2"] }));
    assert.deepEqual(calls, [["model-a", "g1"], ["model-a", "g2"]]); engine.dispose();
});

test("long key interval does not repeatedly retry an overloaded model before trying alternatives", async () => {
    const models = [];
    const { engine } = harness(async url => {
        const model = url.match(/models\/(.*):/)[1]; models.push(model);
        return model === "model-a" ? response(503) : geminiResponse(["ok"]);
    });
    await engine.translate("x", geminiConfig({ autoSwitch: false, intervalMs: 60000 }));
    assert.deepEqual(models, ["model-a", "model-b"]); engine.dispose();
});

test("OpenAI and DeepSeek also rotate registered models", async () => {
    for (const provider of ["openai", "deepseek"]) {
        const models = [];
        const { engine } = harness(async (url, options) => { models.push(JSON.parse(options.body).model); return llm(provider, ["ok"]); });
        const c = config({ provider, autoSwitch: false, [`${provider}Key`]: "key", [`${provider}Model`]: "a", [`${provider}BackupModels`]: "b" });
        await engine.translate("one", c); await engine.translate("two", c);
        assert.deepEqual(models, ["a", "b"]); engine.dispose();
    }
});

test("queue capacity rejection never partially enqueues a bulk submission", async () => {
    const engine = new Translator({ fetch: async () => { throw Error("must not fetch"); } });
    const pending = engine.translate("existing", config());
    await assert.rejects(engine.translateMany(Array.from({ length: 32 }, (_, i) => `item${i}`), config()), /翻訳待ち/);
    assert.equal(engine.pending.size, 1); engine.dispose(); await assert.rejects(pending, /停止/);
});

test('request telemetry only counts actual HTTP sends and stays active until the body is read', async () => {
    let releaseBody, started;
    const ready = new Promise(resolve => { started = resolve; });
    const { engine } = harness(async () => {
        started();
        return { ok: true, status: 200, json: () => new Promise(resolve => { releaseBody = () => resolve({ translations: [{ text: '訳' }] }); }) };
    });
    await assert.rejects(engine.translate('Hello', config({ deeplKey: '' })));
    assert.equal(engine.getActivity().sent, 0);
    const task = engine.translate('Hello', config());
    await ready; await Promise.resolve();
    assert.equal(engine.getActivity().sent, 1); assert.equal(engine.getActivity().active, 1);
    releaseBody(); assert.equal(await task, '訳'); assert.equal(engine.getActivity().active, 0);
    assert.equal(engine.getActivity().lastHttpStatus, 200);
    await engine.translate('Hello', config()); assert.equal(engine.getActivity().sent, 1);
    const snapshot = engine.getActivity(); snapshot.sent = 100; assert.equal(engine.getActivity().sent, 1);
    engine.dispose();
});

test('rate-limit telemetry marks waiting separately and counts every real retry', async () => {
    let count = 0;
    const events = [];
    const { engine } = harness(async () => ++count === 1 ? response(429, {}, { 'Retry-After': '5' }) : deepl(['訳']));
    await engine.translate('Hello', config({ autoSwitch: false }), (message, detail) => events.push(detail?.phase));
    assert.ok(events.includes('queued')); assert.ok(events.includes('waiting')); assert.ok(events.includes('sending'));
    assert.equal(engine.getActivity().sent, 2); assert.equal(engine.getActivity().active, 0);
    engine.dispose();
});

test('offscreen queued text is rejected without an HTTP request, including after a key interval wait', async () => {
    let clock = 0, releaseWait, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const sent = [];
    let hold = false, visible = true;
    const engine = new Translator({ now: () => clock, random: () => 0, sleep: async ms => {
        if (hold && ms > 350) { entered(); await new Promise(resolve => { releaseWait = resolve; }); }
        clock += ms;
    }, fetch: async (url, options) => { const texts = JSON.parse(options.body).text; sent.push(texts); return deepl(texts.map(text => `訳:${text}`)); } });
    await engine.translate('seed', config()); hold = true;
    const old = engine.translate('old viewport', config(), () => {}, { shouldSend: () => visible });
    const rejected = assert.rejects(old, error => error.code === 'TRANSLATION_NOT_VISIBLE');
    const current = engine.translate('still visible', config());
    await waiting; visible = false; releaseWait();
    await rejected; assert.equal(await current, '訳:still visible');
    assert.deepEqual(sent, [['seed'], ['still visible']]); engine.dispose();
});

test('identical text stays queued if a currently visible subscriber still needs it', async () => {
    const sent = [];
    const { engine } = harness(async (url, options) => { const texts = JSON.parse(options.body).text; sent.push(texts); return deepl(['訳']); });
    const old = engine.translate('same', config(), () => {}, { shouldSend: () => false });
    const current = engine.translate('same', config(), () => {}, { shouldSend: () => true });
    engine.pruneQueue(); assert.deepEqual(await Promise.all([old, current]), ['訳', '訳']);
    assert.deepEqual(sent, [['same']]); engine.dispose();
});

test('pruning immediately frees queue capacity and old promise cleanup cannot erase a new identical job', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let visible = true;
    const engine = new Translator({ sleep: () => gate, fetch: async () => deepl(['fresh']) });
    const old = engine.translate('same', config(), () => {}, { shouldSend: () => visible });
    const rejected = assert.rejects(old, error => error.code === 'TRANSLATION_NOT_VISIBLE');
    visible = false; engine.pruneQueue(); assert.equal(engine.pending.size, 0);
    const fresh = engine.translate('same', config());
    await rejected; assert.equal(engine.pending.size, 1);
    release(); assert.equal(await fresh, 'fresh'); assert.equal(engine.pending.size, 0); engine.dispose();
});


test("saved translations survive restart without credentials and clear removes disk and memory", async () => {
    let rows = [], requests = 0, now = 1000;
    const adapter = { load: () => rows, save: value => { rows = JSON.parse(JSON.stringify(value)); } };
    const create = () => new Translator({ now: () => now, sleep: async () => {}, fetch: async () => { requests++; return deepl(["訳文"]); }, persistentCache: adapter });
    const c=config(); let e=create(); assert.equal(await e.translate("Hello",c),"訳文");
    assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(c.deeplKey));assert.ok(!JSON.stringify(rows).includes('deeplKey'));
    e.dispose();now+=86400000;e=create();assert.equal(await e.translate("Hello",c),"訳文");assert.equal(requests,1);
    e.forget("Hello",c);assert.equal(rows.length,0);await e.translate("Hello",c);assert.equal(requests,2);
    e.clearCache();assert.equal(rows.length,0);e.dispose();e=create();await e.translate("Hello",c);assert.equal(requests,3);e.dispose();
});

test("batch completion writes storage once per response and restores every result after restart", async () => {
    let rows = [], saves = 0, requests = 0;
    const adapter = { load: () => rows, save: value => { saves++; rows = JSON.parse(JSON.stringify(value)); } };
    const create = () => new Translator({ sleep: async () => {}, persistentCache: adapter, fetch: async (url, options) => {
        requests++; return deepl(JSON.parse(options.body).text.map(text => `訳:${text}`));
    } });
    const texts = Array.from({ length: 10 }, (_, i) => `batch${i}`);
    let engine = create();
    assert.deepEqual(await engine.translateMany(texts, config()), texts.map(text => `訳:${text}`));
    assert.equal(requests, 2); assert.equal(saves, 2); assert.equal(rows.length, 10);
    engine.dispose(); engine = create();
    assert.deepEqual(await engine.translateMany(texts, config()), texts.map(text => `訳:${text}`));
    assert.equal(requests, 2); assert.equal(saves, 2);
    engine.dispose();
});

test("saved cache separates language/model, expires, bounds storage and ignores malformed entries", async () => {
    let rows = [{key:42,text:'bad',at:100}], now=100, requests=0;
    const adapter={load:()=>rows,save:value=>{rows=value;}};
    const create=()=>new Translator({now:()=>now,sleep:async()=>{},persistentCache:adapter,fetch:async(url,options)=>{requests++;return deepl(JSON.parse(options.body).text.map(t=>'訳'+t));}});
    let e=create();await e.translate('Hello',config());e.dispose();e=create();await e.translate('Hello',config({target:'FR'}));assert.equal(requests,2);
    for(let i=0;i<103;i++)await e.translate('Text'+i,config());assert.ok(rows.length<=100);assert.ok(JSON.stringify(rows).length<450000);e.dispose();
    now+=31*86400000;e=create();await e.translate('Text102',config());assert.equal(requests,106);e.dispose();
});

test("clearing a cache prevents an older in-flight response from being saved again", async () => {
    let rows=[],resolve;const e=new Translator({persistentCache:{load:()=>rows,save:r=>{rows=r;}},sleep:async()=>{},fetch:()=>new Promise(r=>{resolve=r;})});
    const pending=e.translate('Hello',config());await new Promise(r=>setImmediate(r));e.clearCache();resolve(deepl(['訳']));await pending;assert.equal(rows.length,0);assert.equal(e.cache.size,0);e.dispose();
});

test('a non-Gemini HTTP error switches at headers without reading a stalled body and retains Retry-After', async () => {
    let now=0, next=0;const timers=new Map(), calls=[];
    const e=new Translator({now:()=>now,random:()=>0,sleep:async ms=>{now+=ms;},
        setTimer:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),
        fetch:async(url,options)=>{calls.push({key:options.headers.Authorization,at:now});return calls.length===1?{...response(503,{}, {'Retry-After':'90'}),json:()=>new Promise(()=>{})}:deepl(['訳']);}});
    const task=e.translate('Hello',config({deeplBackupKeys:['backup']}));
    assert.equal(await task,'訳');assert.deepEqual(calls.map(c=>c.key),['DeepL-Auth-Key test-deepl','DeepL-Auth-Key backup']);
    assert.equal(calls[1].at-calls[0].at,0);assert.ok([...e.cooldown.values()].some(at=>at>=now+90000));assert.equal(timers.size,0);e.dispose();
});

test('an unresponsive candidate switches at 5 seconds even if fetch ignores abort', async () => {
    let now=0,next=0;const timers=new Map(),deadlines=[],calls=[],statuses=[];
    const e=new Translator({now:()=>now,sleep:async ms=>{now+=ms;},
        setTimer:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});deadlines.push(ms);return id;},clearTimer:id=>timers.delete(id),
        fetch:async(url,options)=>{calls.push(options.signal);return calls.length===1?new Promise(()=>{}):deepl(['訳']);}});
    const task=e.translate('Hello',config({deeplBackupKeys:['backup']}),s=>statuses.push(s));
    for(let i=0;i<20&&!timers.size;i++)await Promise.resolve();
    const timeout=[...timers.values()].find(t=>t.ms===5000);assert.ok(timeout);now+=5000;timeout.fn();
    assert.equal(await task,'訳');assert.equal(calls.length,2);assert.equal(calls[0].aborted,true);assert.ok(statuses.some(s=>s.includes('タイムアウト')));
    assert.deepEqual(deadlines,[5000,5000]);assert.equal(e.getActivity().active,0);assert.equal(timers.size,0);e.dispose();
});

test('network failures switch candidates once each; single-candidate requests keep 60 seconds', async () => {
    const calls=[];const {engine,waits}=harness(async(url,options)=>{calls.push(options.headers.Authorization);if(calls.length===1)throw Error('secret');return deepl(['訳']);});
    assert.equal(await engine.translate('Hello',config({deeplBackupKeys:['backup']})),'訳');assert.equal(calls.length,2);assert.deepEqual(waits,[350]);engine.dispose();
    let deadline;const single=new Translator({sleep:async()=>{},setTimer:(fn,ms)=>{deadline=ms;return 1;},clearTimer:()=>{},fetch:async()=>{throw Error('secret');}});
    await assert.rejects(single.translate('Hello',config()),/60 秒/);assert.equal(deadline,60000);single.dispose();
});

test('all unresponsive fallbacks stop after 5 seconds each, including the final candidate', async () => {
    let now = 0, next = 0;
    const timers = new Map(), signals = [], deadlines = [];
    const engine = new Translator({ now: () => now, sleep: async ms => { now += ms; },
        setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); deadlines.push(ms); return id; },
        clearTimer: id => timers.delete(id), fetch: async (url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
    const task = engine.translate('Hello', config({ deeplBackupKeys: ['backup'] }));
    const rejected = assert.rejects(task, /5 秒/);
    for (let attempt = 0; attempt < 2; attempt++) {
        for (let i = 0; i < 30 && signals.length <= attempt; i++) await Promise.resolve();
        const timer = [...timers.values()].find(t => t.ms === 5000);
        assert.ok(timer); now += 5000; timer.fn();
    }
    await rejected;
    assert.deepEqual(deadlines, [5000, 5000]); assert.ok(signals.every(signal => signal.aborted));
    assert.equal(now, 10350); assert.equal(engine.pending.size, 0); assert.equal(timers.size, 0);
    assert.equal(engine.getActivity().active, 0); engine.dispose();
});

test('429 fallback visits each candidate once without waiting out Retry-After; cooldown persists for later batches', async () => {
    const keys = [];
    const { engine, waits } = harness(async (url, options) => {
        keys.push(options.headers.Authorization); return response(429, {}, { 'Retry-After': '90' });
    });
    await assert.rejects(engine.translate('Hello', config({ deeplBackupKeys: ['backup'] })), /登録済み API/);
    assert.deepEqual(keys, ['DeepL-Auth-Key test-deepl', 'DeepL-Auth-Key backup']);
    assert.deepEqual(waits, [350]); assert.equal(engine.cooldown.size, 2);
    assert.ok([...engine.cooldown.values()].every(at => at >= 90350)); engine.dispose();
});

test('late success from a timed-out candidate cannot replace or cache over the successful fallback', async () => {
    let timeout, release, calls = 0;
    const engine = new Translator({ sleep: async () => {}, setTimer: fn => { timeout = fn; return 1; }, clearTimer() {},
        fetch: async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : deepl(['fresh']) });
    const task = engine.translate('Hello', config({ deeplBackupKeys: ['backup'] }));
    for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
    timeout(); assert.equal(await task, 'fresh');
    release(deepl(['stale'])); await Promise.resolve(); await Promise.resolve();
    assert.equal(await engine.translate('Hello', config({ deeplBackupKeys: ['backup'] })), 'fresh');
    assert.equal(calls, 2); assert.equal(engine.getActivity().active, 0); engine.dispose();
});

test('Gemini translation requests disable thinking or select the lowest supported level for each model', () => {
    const cases = [
        ['gemini-2.5-flash', { thinkingBudget: 0 }], ['models/gemini-2.5-flash-lite', { thinkingBudget: 0 }],
        ['gemini-2.5-pro', { thinkingBudget: 128 }], ['gemini-3-flash-preview', { thinkingLevel: 'minimal' }],
        ['gemini-3.5-flash-lite', { thinkingLevel: 'minimal' }], ['gemini-3.6-flash', { thinkingLevel: 'minimal' }],
        ['gemini-3.8-flash', { thinkingLevel: 'low' }], ['gemini-3.1-pro-preview', { thinkingLevel: 'low' }],
        ['gemini-4-argon', { thinkingLevel: 'low' }],
    ];
    for (const [geminiModel, expected] of cases) {
        const body = makeRequest(['Hello'], normalizeConfig(geminiConfig({ geminiModel }))).body;
        assert.deepEqual(body.generationConfig.thinkingConfig, expected, geminiModel);
        assert.equal(body.generationConfig.maxOutputTokens, 8192);
    }
    assert.equal(makeRequest(['Hello'], normalizeConfig(geminiConfig({ geminiModel: 'gemini-2.0-flash' }))).body.generationConfig.thinkingConfig, undefined);
});

test('OpenAI reasoning uses off or the model minimum without adding unsupported fields to older models', () => {
    const cases = [
        ['gpt-5', 'minimal'], ['gpt-5-mini', 'minimal'], ['gpt-5-nano-2025-08-07', 'minimal'],
        ['gpt-5.1', 'none'], ['gpt-5.2', 'none'], ['gpt-5-codex', 'low'],
        ['gpt-5-pro', 'high'], ['gpt-5.2-pro', 'medium'], ['gpt-6-astra', 'low'], ['gpt-6.1-sol', 'low'],
        ['gpt-6-sol', 'none'], ['gpt-6-luna', 'none'], ['o3-mini', 'low'], ['o4-mini', 'low'],
    ];
    for (const [openaiModel, effort] of cases) {
        const body = makeRequest(['Hello'], normalizeConfig(config({ provider: 'openai', openaiKey: 'test', openaiModel }))).body;
        assert.deepEqual(body.reasoning, { effort }, openaiModel);
    }
    for (const openaiModel of ['gpt-4o-mini', 'gpt-4.1', 'unknown-model'])
        assert.equal(makeRequest(['Hello'], normalizeConfig(config({ provider: 'openai', openaiKey: 'test', openaiModel }))).body.reasoning, undefined);
});

test('DeepSeek explicitly disables thinking; OpenRouter requests the minimal mapped reasoning level', () => {
    const deepseek = makeRequest(['Hello'], normalizeConfig(config({ provider: 'deepseek', deepseekKey: 'test', deepseekModel: 'deepseek-flash' }))).body;
    assert.deepEqual(deepseek.thinking, { type: 'disabled' }); assert.equal(deepseek.reasoning_effort, 'low');
    const router = makeRequest(['Hello'], normalizeConfig(config({ provider: 'openrouter', openrouterKey: 'test', openrouterModel: 'google/gemini-3.8-flash' }))).body;
    assert.deepEqual(router.reasoning, { effort: 'minimal', exclude: true });
    assert.equal(router.thinking, undefined); assert.equal(router.reasoning_effort, undefined);
    assert.equal(makeRequest(['Hello'], normalizeConfig(config())).body.reasoning, undefined);
});

test('one Japanese character suppresses all requests and cached replacements regardless of target', async () => {
    let requests = 0;
    const engine = new Translator({ fetch: async () => { requests++; throw Error('must not send'); } });
    const samples = ['Hello あ', 'Hello ア', 'Hello ｱ', 'Hello 漢', 'Hello 𠮷', 'Hello `あ`', 'Hello https://example.com/日', 'Hello <@あ>'];
    for (const target of ['JA', 'EN-US']) for (const text of samples) {
        const c = config({ target });
        engine.cache.set(JSON.stringify([text, JSON.stringify(normalizeConfig(c))]), { text: 'old cached translation', at: Date.now() });
        const phases = [];
        assert.equal(await engine.translate(text, c, (_, event) => phases.push(event.phase)), text);
        assert.deepEqual(phases, ['skipped']);
    }
    assert.equal(await engine.translate('日本語', {}), '日本語');
    assert.deepEqual(await engine.translateMany(['Hello あ', '日本語'], {}), ['Hello あ', '日本語']);
    assert.equal(requests, 0); assert.equal(engine.pending.size, 0); assert.equal(engine.queue.length, 0);
    engine.dispose();
});

test('bulk translation preserves mixed Japanese inputs in order and only sends eligible text', async () => {
    const sent = [];
    const { engine } = harness(async (url, options) => { const texts = JSON.parse(options.body).text; sent.push(texts); return deepl(texts.map(t => `訳:${t}`)); });
    assert.deepEqual(await engine.translateMany(['Hello', 'Hello あ', 'Bye', 'ｶﾅ'], config()), ['訳:Hello', 'Hello あ', '訳:Bye', 'ｶﾅ']);
    assert.deepEqual(sent, [['Hello', 'Bye']]); engine.dispose();
});

test('Japanese inputs do not consume bulk queue capacity', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const engine = new Translator({ sleep: () => gate, fetch: async (url, options) => deepl(JSON.parse(options.body).text) });
    const tasks = Array.from({ length: 31 }, (_, i) => engine.translate(`Pending ${i}`, config()));
    const bulk = engine.translateMany(['Hello あ', 'Final'], config());
    assert.equal(engine.pending.size, 32);
    release(); assert.deepEqual(await bulk, ['Hello あ', 'Final']); await Promise.all(tasks); engine.dispose();
});
