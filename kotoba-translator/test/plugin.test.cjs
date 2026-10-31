const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { parse } = require("acorn");

test("saved configuration snapshots are reused and notice scalar and in-place array changes", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/plugin.js"), "utf8")
        .replace("settings: Settings,", "readConfig: config, settings: Settings,") + "\ncreatePlugin;";
    const create = vm.runInNewContext(source, { createOpenRouterModelPicker: () => null, createStatisticsScreen: () => null });
    const storage = { deeplBackupKeys: ['backup'] };
    const plugin = create({ plugin: { storage }, metro: { common: { React: { createElement() {} } } } }, require('../src/core.cjs'));
    const first = plugin.readConfig();
    assert.equal(plugin.readConfig(), first);
    storage.target = 'FR'; const second = plugin.readConfig();
    assert.notEqual(second, first); assert.equal(second.target, 'FR'); assert.equal(first.target, 'JA');
    storage.deeplBackupKeys.push('another'); const third = plugin.readConfig();
    assert.notEqual(third, second); assert.equal(third.deeplBackupKeys.length, 2);
    assert.equal(second.deeplBackupKeys.length, 1); assert.equal(plugin.readConfig(), third);
    storage.deeplBackupKeys = ['backup', 'another']; assert.equal(plugin.readConfig(), third);
    storage.deeplKey = 'changed'; assert.notEqual(plugin.readConfig(), third);
});

test("distribution lowers Hermes-unsupported classes/async and remains a single Kettu return expression", () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    const ast = parse(source, { ecmaVersion: 2015 });
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].type, "ExpressionStatement");
    function check(node) {
        if (!node || typeof node !== "object") return;
        assert.ok(!["ClassDeclaration", "ClassExpression"].includes(node.type), "Hermes cannot evaluate classes");
        if (node.type === "VariableDeclaration") assert.equal(node.kind, "var", "Hermes eval must not rely on loop let/const capture");
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(check);
            else if (value && typeof value === "object") check(value);
        }
    }
    check(ast);
    parse(`vendetta=>{return ${source}}`, { ecmaVersion: 2015 });
});

test("built plugin rotates providers through commands and resets its cursor after reload", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    const calls = [], copied = [], commands = [];
    const storage = { provider: "deepl", deeplKey: "mock", openaiKey: "mock", openaiModel: "mock-model", providerRotation: true, intervalMs: 1000 };
    const vendetta = {
        plugin: { storage },
        metro: { common: { React: { createElement() {} }, ReactNative: {}, clipboard: { setString: text => copied.push(text) } } },
        ui: { toasts: { showToast() {} } },
        commands: { registerCommand: command => { commands.push(command); return () => {}; } },
    };
    const plugin = vm.runInNewContext(source, { vendetta, setTimeout, clearTimeout, AbortController, fetch: async url => {
        const provider = url.includes("deepl") ? "deepl" : "openai";
        calls.push(provider);
        return { ok: true, status: 200, json: async () => provider === "deepl" ? { translations: [{ text: "訳" }] } : {
            status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"translations":[{"id":0,"text":"訳"}]}' }] }],
        } };
    } });
    plugin.onLoad();
    for (const value of ["first", "second", "third"]) await commands[0].execute([{ name: "text", value }]);
    assert.deepEqual(calls, ["deepl", "openai", "deepl"]);
    plugin.onUnload(); plugin.onLoad();
    await commands[1].execute([{ name: "text", value: "fourth" }]);
    assert.deepEqual(calls, ["deepl", "openai", "deepl", "deepl"]);
    assert.equal(copied.length, 4);
    assert.equal(storage.providerRotation, true);
    assert.equal(storage.requestStatistics.rows.reduce((sum, row) => sum + row.sent, 0), 4);
    assert.equal(storage.requestStatistics.rows.find(row => row.provider === "openai").model, "mock-model");
    assert.equal(storage.requestStatistics.rows.find(row => row.provider === "deepl").success, 3);
    plugin.onUnload();
});

test("built expression loads with Kettu lifecycle, UI renders, command never posts", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    assert.equal(manifest.hash, crypto.createHash("sha256").update(source).digest("hex"));
    const alerts = [], copied = [], commands = [], toasts = [];
    let removed = 0;
    const react = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: value => [typeof value === "function" ? value() : value, () => {}],
        useRef: value => ({ current: value }), useEffect: fn => fn(),
    };
    const storage = { provider: "deepl", deeplKey: "mock" };
    const vendetta = {
        plugin: { storage },
        metro: { common: { React: react, ReactNative: { useColorScheme: () => "dark", Platform: { OS: "ios" }, Alert: { alert: (...args) => alerts.push(args) } }, clipboard: { setString: text => copied.push(text) } } },
        ui: { toasts: { showToast(message) { toasts.push(message); } } },
        commands: { registerCommand: command => { commands.push(command); return () => { removed++; }; } },
    };
    const context = vm.createContext({ vendetta, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortController, fetch: async () => ({ ok: true, json: async () => ({ translations: [{ text: "こんにちは" }] }) }) });
    const plugin = vm.runInContext(source, context);
    plugin.onLoad(); plugin.onLoad(); assert.equal(commands.length, 1);
    assert.ok(plugin.settings());
    const result = await commands[0].execute([{ name: "text", value: "hello" }]);
    assert.equal(result, undefined); assert.equal(alerts.length, 0);
    assert.deepEqual(copied, ["こんにちは"]);
    storage.provider = "gemini"; storage.geminiKey = "mock";
    assert.equal(await commands[0].execute([{ name: "text", value: "hello" }]), undefined);
    assert.equal(toasts.at(-1), "設定で利用するモデル ID を入力してください。");
    assert.equal(alerts.length, 0);
    plugin.onUnload(); assert.equal(removed, 1);
    plugin.onLoad(); plugin.onUnload(); assert.equal(removed, 2);
});
