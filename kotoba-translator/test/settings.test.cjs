const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    let cursor = 0;
    const slots = [], effects = [], requests = [];
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(value) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
            return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
        },
        useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
        useEffect(fn, deps) {
            const i = cursor++;
            if (!slots[i] || deps.some((dep, n) => dep !== slots[i].deps[n])) {
                effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
            }
        },
    };
    class Translator {
        translate(text, config, report) { return new Promise((resolve, reject) => requests.push({ resolve, reject, report })); }
        dispose() {} // A transport may still resolve after cancellation.
    }
    const source = fs.readFileSync(require.resolve('../src/plugin.js'), 'utf8') + '\ncreatePlugin;';
    const create = vm.runInNewContext(source, {
        setInterval: () => 0, clearInterval() {},
        createOpenRouterModelPicker: () => null, createStatisticsScreen: () => null,
        createAddonIntegration: () => ({ install() {}, dispose() {} }),
        createMessageIntegration: () => ({ install() {}, dispose() {}, status() {} }),
    });
    const RN = { useColorScheme: () => 'light', Platform: { OS: 'ios' } };
    for (const name of ['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'KeyboardAvoidingView']) RN[name] = name;
    const plugin = create({
        plugin: { storage: {} }, metro: { common: { React, ReactNative: RN } },
        commands: { registerCommand: () => () => {} },
    }, { ...require('../src/core.cjs'), Translator, createRequestStatistics: () => ({}) });
    plugin.onLoad();
    return { plugin, requests, render() {
        cursor = 0;
        const tree = plugin.settings();
        effects.splice(0).forEach(fn => fn());
        return tree;
    } };
}
function nodes(tree) {
    return !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)];
}
const field = (tree, label) => nodes(tree).find(n => n.props?.accessibilityLabel === label);
const resultShown = tree => nodes(tree).some(n => n.children?.includes('stale translation'));

for (const outcome of ['success', 'failure']) for (const change of ['input', 'settings', 'reload']) {
    test(`manual translation discards late ${outcome} after ${change}`, async () => {
        const e = setup();
        let tree = e.render();
        field(tree, '翻訳する文章').props.onChangeText('first');
        tree = e.render();
        const pending = field(tree, '翻訳する').props.onPress();
        tree = e.render();
        if (change === 'input') field(tree, '翻訳する文章').props.onChangeText('second');
        if (change === 'settings') field(tree, '翻訳先の言語コード').props.onChangeText('FR');
        if (change === 'reload') { e.plugin.onUnload(); e.plugin.onLoad(); }
        e.render();
        e.requests[0].report('stale progress');
        if (outcome === 'success') e.requests[0].resolve('stale translation');
        else e.requests[0].reject(new Error('late failure'));
        await pending;
        tree = e.render();
        assert.equal(resultShown(tree), false);
        assert.equal(nodes(tree).some(n => n.children?.includes('stale progress')), false);
        assert.equal(nodes(tree).some(n => n.children?.includes('翻訳に失敗しました。設定を確認してください。')), false);
        e.plugin.onUnload();
    });
}

test('a late request cannot overwrite a newer translation or unlock its button', async () => {
    const e = setup();
    let tree = e.render();
    field(tree, '翻訳する文章').props.onChangeText('first');
    tree = e.render();
    const first = field(tree, '翻訳する').props.onPress();
    tree = e.render();
    field(tree, '翻訳する文章').props.onChangeText('second');
    e.render(); // Flush the effect that invalidates the previous request.
    tree = e.render();
    const second = field(tree, '翻訳する').props.onPress();
    e.requests[0].resolve('stale translation');
    await first;
    tree = e.render();
    assert.equal(resultShown(tree), false);
    assert.equal(field(tree, '待機・翻訳中…').props.disabled, true);
    e.requests[1].resolve('current translation');
    await second;
    tree = e.render();
    assert.equal(nodes(tree).some(n => n.children?.includes('current translation')), true);
    assert.equal(field(tree, '翻訳する').props.disabled, false);
    e.plugin.onUnload();
});
