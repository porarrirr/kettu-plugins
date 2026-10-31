const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const createAddonIntegration = vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/addon-ui.js"), "utf8") + "\ncreateAddonIntegration;");
const addon = { name: "Example", description: "Tap a message to translate it.", installUrl: "https://example.org/plugin/" };

function harness() {
    let cursor = 0;
    const slots = [], effects = [];
    const node = (type, props, ...children) => ({ type, props, children });
    const React = {
        createElement: node,
        useState(value) {
            const id = cursor++;
            if (!(id in slots)) slots[id] = value;
            return [slots[id], value => { slots[id] = typeof value === "function" ? value(slots[id]) : value; }];
        },
        useRef(value) { const id = cursor++; return slots[id] ||= { current: value }; },
        useEffect(fn, deps) {
            const id = cursor++;
            if (!slots[id] || deps.some((dep, i) => dep !== slots[id].deps[i])) {
                effects.push(() => { slots[id]?.cleanup?.(); slots[id] = { deps, cleanup: fn() }; });
            }
        },
    };
    const runtime = { jsx: node, jsxs: node, Fragment: Symbol.for("react.fragment") };
    const copied = [], calls = [];
    let c = { target: "JA", provider: "deepl" };
    const vendetta = {
        metro: { common: { React, ReactNative: { View: "View", Text: "Text", Pressable: "Pressable", useColorScheme: () => "light" }, clipboard: { setString: x => copied.push(x) } }, findByProps: () => runtime },
        patcher: { before(name, object, callback) {
            const original = object[name];
            object[name] = function (...args) { callback(args); return original.apply(this, args); };
            return () => { object[name] = original; };
        } },
    };
    let resolve;
    const engine = { translate(text, config, status) { calls.push({ text, config }); status("翻訳中"); return new Promise(yes => { resolve = yes; }); } };
    const integration = createAddonIntegration(vendetta, { getTranslator: () => engine, getConfig: () => c, errorMessage: error => error.message });
    function mount(element) {
        return { render(props = element.props) { cursor = 0; const tree = element.type(props); for (const effect of effects.splice(0)) effect(); return tree; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
    }
    function list(data = [addon], renderItem = info => node("OriginalCard", { item: info.item })) {
        return runtime.jsx("List", { data, renderItem });
    }
    return { integration, runtime, React, calls, copied, list, mount, finish: text => resolve(text), setConfig: value => { c = value; } };
}

function all(tree, predicate) {
    if (!tree || typeof tree !== "object") return [];
    return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => Array.isArray(child) ? child.flatMap(x => all(x, predicate)) : all(child, predicate))];
}
const buttons = tree => all(tree, node => node.type === "Pressable");

test("catalog list gains translation controls while preserving original props/cards; no requests on render", () => {
    const env = harness(); assert.equal(env.integration.install(), true);
    const data = Object.freeze([Object.freeze({ ...addon })]);
    const renderItem = info => ({ type: "OriginalCard", props: { item: info.item } });
    const props = Object.freeze({ data, renderItem, extraData: "unchanged" });
    const list = env.runtime.jsxs("List", props);
    assert.notEqual(list.props, props); assert.equal(props.renderItem, renderItem);
    assert.equal(list.props.extraData, "unchanged");
    const row = list.props.renderItem({ item: data[0], index: 0 });
    assert.equal(row.children[0].type, "OriginalCard"); assert.equal(row.children[0].props.item, data[0]);
    const view = env.mount(row.children[1]); view.render();
    assert.equal(buttons(view.render())[0].props.accessibilityLabel, "Example: 説明を翻訳");
    assert.equal(env.calls.length, 0); env.integration.dispose(); view.unmount();
});

test("ordinary messages, noncatalog lists and empty lists are left untouched", () => {
    const env = harness(); env.integration.install();
    for (const data of [[], [{ content: "secret chat", id: "1" }], [{ name: "x", description: "x" }]]) {
        const renderItem = () => "unchanged";
        assert.equal(env.list(data, renderItem).props.renderItem, renderItem);
    }
    const props = { children: "Tap a message to…" };
    assert.equal(env.React.createElement("Text", props).props, props);
    env.integration.dispose();
});

test("translate uses saved configuration; shows and copies the translation without changing the description", async () => {
    const env = harness(); env.integration.install();
    const row = env.list().props.renderItem({ item: addon });
    const view = env.mount(row.children[1]); view.render();
    const task = buttons(view.render())[0].props.onPress();
    assert.equal(env.calls.length, 1); assert.equal(env.calls[0].text, addon.description); assert.equal(env.calls[0].config.target, "JA");
    assert.equal(buttons(view.render())[0].props.disabled, true);
    env.finish("翻訳するにはメッセージをタップしてください。"); await task;
    const tree = view.render();
    assert.ok(all(tree, node => node.type === "Text").some(node => node.children.includes("翻訳するにはメッセージをタップしてください。")));
    buttons(tree)[1].props.onPress(); assert.deepEqual(env.copied, ["翻訳するにはメッセージをタップしてください。"]);
    buttons(tree)[0].props.onPress(); assert.equal(buttons(view.render()).length, 1);
    assert.equal(addon.description, "Tap a message to translate it."); env.integration.dispose(); view.unmount();
});

test("settings change and recycled rows discard stale in-flight translations", async () => {
    const env = harness(); env.integration.install();
    const view = env.mount(env.list().props.renderItem({ item: addon }).children[1]); view.render();
    const task = buttons(view.render())[0].props.onPress();
    env.setConfig({ target: "FR" }); env.integration.refresh(); env.finish("old Japanese translation"); await task;
    assert.equal(buttons(view.render()).length, 1);
    const next = { ...addon, description: "A different addon description" };
    view.render({ addon: next });
    const nextTask = buttons(view.render({ addon: next }))[0].props.onPress();
    assert.equal(env.calls[1].text, next.description); assert.equal(env.calls[1].config.target, "FR");
    view.unmount(); env.finish("late"); await nextTask; env.integration.dispose();
});

test("unload removes patches and hides mounted controls; repeated renders do not double wrap", () => {
    const env = harness();
    const original = env.runtime.jsx; env.integration.install(); env.integration.install();
    const first = env.list(); const second = env.runtime.jsx("List", first.props);
    assert.equal(first.props.renderItem, second.props.renderItem);
    const view = env.mount(first.props.renderItem({ item: addon }).children[1]); view.render();
    env.integration.dispose(); assert.equal(env.runtime.jsx, original); assert.equal(view.render(), null);
    assert.equal(first.props.renderItem({ item: addon }).type, "OriginalCard"); view.unmount();
});
