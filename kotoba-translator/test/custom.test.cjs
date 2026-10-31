const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Translator, DEFAULTS, PROVIDERS, makeRequest, normalizeConfig, parseTranslation, candidates, createRequestStatistics } = require("../src/core.cjs");
const config = extra => normalizeConfig({ ...DEFAULTS, provider: "custom", customBaseUrl: "https://llm.local/v1", customModel: "local-model", ...extra });
const response = (status, data = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data, headers: { get: name => headers[name] } });
const jsonReply = texts => JSON.stringify({ translations: texts.map((text, id) => ({ id, text })).reverse() });
const chat = texts => response(200, { choices: [{ finish_reason: "stop", message: { content: jsonReply(texts) } }] });
const responsesApi = texts => response(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: jsonReply(texts) }] }] });
const anthropic = texts => response(200, { stop_reason: "end_turn", content: [{ type: "text", text: jsonReply(texts) }] });
const replyFor = format => format === "openai-chat" ? chat(["訳"]) : format === "openai-responses" ? responsesApi(["訳"]) : anthropic(["訳"]);

function harness(reply) {
    let clock = 0;
    const calls = [], reports = [], statistics = createRequestStatistics();
    const engine = new Translator({ now: () => clock, random: () => 0, sleep: async ms => { clock += ms; },
        onRequest: event => statistics.start(event), fetch: async (url, options) => {
            const provider = url.includes("llm.local") ? "custom" : url.includes("deepl") ? "deepl" : url.includes("openai") ? "openai" : "gemini";
            const call = { provider, url, body: JSON.parse(options.body), headers: options.headers, at: clock };
            calls.push(call);
            return reply({ provider, count: calls.length, ...call, advance: ms => { clock += ms; } });
        } });
    return { engine, calls, reports, statistics, advance: ms => { clock += ms; },
        run: (c = config(), texts = ["hello"]) => engine.run(texts, c, (message, detail) => reports.push({ message, detail })) };
}

test("custom openai-chat appends the endpoint path and sends JSON mode without reasoning fields", () => {
    for (const [base, expected] of [
        ["https://llm.local/v1", "https://llm.local/v1/chat/completions"],
        ["https://llm.local/v1/", "https://llm.local/v1/chat/completions"],
        ["https://llm.local", "https://llm.local/chat/completions"],
        ["https://llm.local/v1/chat/completions", "https://llm.local/v1/chat/completions"],
        ["https://llm.local/v1?key=abc", "https://llm.local/v1/chat/completions?key=abc"],
    ]) {
        const request = makeRequest(["one"], config({ customBaseUrl: base, customKey: "k" }));
        assert.equal(request.url, expected);
        assert.equal(request.headers.Authorization, "Bearer k");
        assert.equal(request.headers["x-api-key"], undefined);
        assert.equal(request.body.model, "local-model");
        assert.equal(request.body.stream, false);
        assert.equal(request.body.max_tokens, 8192);
        assert.deepEqual(request.body.response_format, { type: "json_object" });
        assert.deepEqual(JSON.parse(request.body.messages[1].content).items, [{ id: 0, text: "one" }]);
        assert.equal(request.body.messages[0].role, "system");
        assert.equal(request.body.reasoning_effort, undefined);
        assert.equal(request.body.thinking, undefined);
    }
    const keyless = makeRequest(["one"], config());
    assert.equal(keyless.headers.Authorization, undefined);
    assert.deepEqual(Object.keys(keyless.headers), ["Content-Type"]);
});

test("custom openai-responses keeps the Responses wire shape and sends no reasoning for unknown models", () => {
    for (const [base, expected] of [
        ["https://llm.local/v1", "https://llm.local/v1/responses"],
        ["https://llm.local/gateway/v1/responses", "https://llm.local/gateway/v1/responses"],
    ]) {
        const request = makeRequest(["one", "two"], config({ customBaseUrl: base, customFormat: "openai-responses", customKey: "k", customModel: "gpt-5" }));
        assert.equal(request.url, expected);
        assert.equal(request.headers.Authorization, "Bearer k");
        assert.equal(request.body.model, "gpt-5");
        assert.equal(request.body.store, false);
        assert.equal(request.body.max_output_tokens, 8192);
        assert.deepEqual(request.body.text, { format: { type: "json_object" } });
        assert.deepEqual(JSON.parse(request.body.input).items, [{ id: 0, text: "one" }, { id: 1, text: "two" }]);
        assert.equal(typeof request.body.instructions, "string");
        assert.equal(request.body.reasoning, undefined);
    }
});

test("custom anthropic targets /v1/messages with x-api-key and the messages wire shape", () => {
    for (const [base, expected] of [
        ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
        ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"],
        ["https://gw.example/claude/v1", "https://gw.example/claude/v1/messages"],
        ["https://gw.example/claude/v1/messages", "https://gw.example/claude/v1/messages"],
    ]) {
        const request = makeRequest(["one"], config({ customBaseUrl: base, customFormat: "anthropic", customKey: "ak" }));
        assert.equal(request.url, expected);
        assert.equal(request.headers["x-api-key"], "ak");
        assert.equal(request.headers["anthropic-version"], "2023-06-01");
        assert.equal(request.headers.Authorization, undefined);
        assert.equal(request.body.model, "local-model");
        assert.equal(request.body.max_tokens, 8192);
        assert.equal(request.body.stream, false);
        assert.equal(typeof request.body.system, "string");
        assert.deepEqual(JSON.parse(request.body.messages[0].content).items, [{ id: 0, text: "one" }]);
        assert.equal(request.body.response_format, undefined);
    }
    const keyless = makeRequest(["one"], config({ customFormat: "anthropic" }));
    assert.equal(keyless.headers["x-api-key"], undefined);
    assert.equal(keyless.headers["anthropic-version"], "2023-06-01");
});

test("custom configuration requires base URL, format and model but allows an empty key", () => {
    assert.equal(normalizeConfig(config({ customKey: "" })).customKey, "");
    assert.throws(() => normalizeConfig(config({ customBaseUrl: "" })), /ベース URL/);
    assert.throws(() => normalizeConfig(config({ customBaseUrl: "ftp://llm.local/v1" })), /ベース URL/);
    assert.throws(() => normalizeConfig(config({ customBaseUrl: "https://" })), /ベース URL/);
    assert.throws(() => normalizeConfig(config({ customFormat: "bogus" })), /API 形式/);
    assert.throws(() => normalizeConfig(config({ customModel: "" })), /モデル ID/);
    assert.deepEqual(candidates(config({ customKey: "", customBackupKeys: ["", ""] })).map(row => [row.provider, row.customKey, row.customModel]), [["custom", "", "local-model"]]);
    assert.deepEqual(candidates({ ...DEFAULTS, provider: "deepl", deeplKey: "d", customKey: "k", customModel: "m" }).filter(row => row.provider === "custom"), []);
    assert.deepEqual([...new Set(candidates(normalizeConfig({ ...DEFAULTS, provider: "deepl", deeplKey: "d", providerRotation: true,
        openaiKey: "o", openaiModel: "m", deepseekKey: "s", deepseekModel: "m", geminiKey: "g", geminiModel: "m",
        openrouterKey: "r", openrouterModel: "m", customBaseUrl: "https://llm.local/v1", customModel: "m" })).map(row => row.provider))],
        ["deepl", "openai", "deepseek", "gemini", "openrouter", "custom"]);
});

test("each custom format translates end to end with its own wire shape", async () => {
    for (const format of ["openai-chat", "openai-responses", "anthropic"]) {
        const e = harness(({ provider }) => provider === "custom" ? replyFor(format) : chat(["訳"]));
        assert.deepEqual(await e.run(config({ customFormat: format })), ["訳"]);
        const call = e.calls[0];
        assert.equal(call.provider, "custom");
        assert.equal(call.url, `https://llm.local/v1/${format === "openai-chat" ? "chat/completions" : format === "openai-responses" ? "responses" : "messages"}`);
        assert.ok(e.reports.some(row => row.message.includes("カスタム · キー 1 · local-model 翻訳中…")));
        assert.deepEqual(e.statistics.snapshot().models.map(row => [row.provider, row.model, row.sent, row.success]), [["custom", "local-model", 1, 1]]);
        e.engine.dispose();
    }
});

test("custom reply envelopes are validated per format", () => {
    assert.deepEqual(parseTranslation({ choices: [{ finish_reason: "stop", message: { content: jsonReply(["一", "二"]) } }] }, "custom", 2, "openai-chat"), ["一", "二"]);
    assert.throws(() => parseTranslation({ choices: [{ finish_reason: "length", message: { content: jsonReply(["一"]) } }] }, "custom", 1, "openai-chat"), /途中/);
    assert.deepEqual(parseTranslation({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: jsonReply(["一"]) }] }] }, "custom", 1, "openai-responses"), ["一"]);
    assert.throws(() => parseTranslation({ status: "incomplete", output: [] }, "custom", 1, "openai-responses"), /完了/);
    assert.deepEqual(parseTranslation({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: jsonReply(["一"]) }] }, "custom", 1, "anthropic"), ["一"]);
    assert.deepEqual(parseTranslation({ stop_reason: "stop_sequence", content: [{ type: "text", text: jsonReply(["一"]) }] }, "custom", 1, "anthropic"), ["一"]);
    assert.throws(() => parseTranslation({ stop_reason: "max_tokens", content: [{ type: "text", text: jsonReply(["一"]) }] }, "custom", 1, "anthropic"), /途中/);
    assert.throws(() => parseTranslation({ content: [{ type: "text", text: jsonReply(["一"]) }] }, "custom", 1, "anthropic"), /途中/);
    assert.throws(() => parseTranslation({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }, "custom", 1, "anthropic"), /形式・ID/);
});

test("custom endpoint failures switch to a configured built-in service and back", async () => {
    const e = harness(({ provider, count }) => count === 1 ? response(503) : provider === "custom" ? chat(["訳"]) : responsesApi(["訳"]));
    assert.deepEqual(await e.run(config({ openaiKey: "o", openaiModel: "oa" })), ["訳"]);
    assert.deepEqual(e.calls.map(row => row.provider), ["custom", "openai"]);
    assert.equal(e.calls[1].at - e.calls[0].at, 0);
    assert.equal(e.statistics.snapshot().total.failed, 1);
    e.engine.dispose();
    const f = harness(({ provider, count }) => count === 1 ? response(503) : provider === "custom" ? chat(["訳"]) : responsesApi(["訳"]));
    assert.deepEqual(await f.run(config({ provider: "openai", openaiKey: "o", openaiModel: "oa" })), ["訳"]);
    assert.deepEqual(f.calls.map(row => row.provider), ["openai", "custom"]);
    f.engine.dispose();
});

test("provider rotation alternates the selected service and a configured custom endpoint", async () => {
    const e = harness(({ provider }) => provider === "deepl" ? response(200, { translations: [{ text: "訳" }] }) : chat(["訳"]));
    const c = config({ provider: "deepl", deeplKey: "d", providerRotation: true });
    for (let i = 0; i < 2; i++) {
        await e.engine.translate(`text${i}`, c);
        await e.engine.translate(`text${i}`, c);
        e.advance(3000);
    }
    assert.deepEqual(e.calls.map(row => row.provider), ["deepl", "custom"]);
    assert.equal(e.calls[1].body.model, "local-model");
    e.engine.dispose();
});

test("settings render the custom endpoint controls and switch formats", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/plugin.js"), "utf8") + "\ncreatePlugin;";
    let cursor = 0;
    const slots = [];
    const react = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
        useRef: value => ({ current: value }),
        useEffect(fn) { fn(); },
    };
    const RN = { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: "ios" }, useColorScheme: () => "dark", Alert: { alert() {} } };
    const storage = { provider: "custom", customBaseUrl: "https://llm.local/v1", customModel: "local-model", customFormat: "anthropic" };
    const vendetta = { plugin: { storage }, metro: { common: { React: react, ReactNative: RN, clipboard: { setString() {} } } }, ui: { toasts: { showToast() {} } } };
    const plugin = vm.runInNewContext(source, { vendetta, setInterval: () => 0, clearInterval() {}, createOpenRouterModelPicker: () => null, createStatisticsScreen: () => null })(vendetta, require("../src/core.cjs"));
    const nodes = tree => !tree || typeof tree !== "object" ? [] : [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)];
    const control = (tree, label, type = "Pressable") => nodes(tree).find(node => node.type === type && node.props.accessibilityLabel === label);
    const render = () => { cursor = 0; return plugin.settings(); };
    let tree = render();
    slots[0] = "settings";
    tree = render();
    assert.equal(control(tree, "Anthropic Messages").props.accessibilityState.selected, true);
    assert.equal(control(tree, "OpenAI Chat").props.accessibilityState.selected, false);
    assert.equal(control(tree, "ベース URL", "TextInput").props.value, "https://llm.local/v1");
    assert.ok(control(tree, "API キー（キー不要のサーバーは空欄）", "TextInput"));
    assert.equal(control(tree, "優先モデル ID", "TextInput").props.value, "local-model");
    control(tree, "OpenAI Chat").props.onPress();
    tree = render();
    assert.equal(control(tree, "OpenAI Chat").props.accessibilityState.selected, true);
    assert.equal(control(tree, "ベース URL", "TextInput").props.placeholder, "https://api.openai.com/v1");
});
