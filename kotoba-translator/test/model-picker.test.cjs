const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup() {
    let cursor = 0, resolve;
    const slots = [], effects = [], calls = [], primary = [], backups = [];
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
        useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
        useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((dep, n) => dep !== slots[i].deps[n])) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    };
    const create = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/model-picker.js'), 'utf8') + '\ncreateOpenRouterModelPicker;', { AbortController });
    const Component = create({ metro: { common: { React, ReactNative: { View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', useColorScheme: () => 'light' } } } }, {
        getTranslator: () => ({ listOpenRouterModels(key, options) { calls.push({ key, options }); return new Promise(yes => { resolve = yes; }); } }), errorMessage: error => error.message,
    });
    let props = { apiKey: '', selected: '', backups: '', onPrimary: id => primary.push(id), onBackup: id => backups.push(id) };
    return { calls, primary, backups, finish: data => resolve(data), render(extra = {}) { props = { ...props, ...extra }; cursor = 0; const tree = Component(props); effects.splice(0).forEach(fn => fn()); return tree; }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)]; }
const button = (tree, label) => nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label);
const samples = Array.from({ length: 25 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}`, promptPrice: '0', completionPrice: i === 0 ? '0' : '0.000001', free: i === 0 }));

test('model picker only loads on request and supports search, free filter, pages and model selection', async () => {
    const e = setup(); let tree = e.render(); assert.equal(e.calls.length, 0);
    const pending = button(tree, 'OpenRouter のモデル一覧を取得・更新').props.onPress();
    e.finish(samples); await pending; tree = e.render();
    assert.equal(nodes(tree).filter(n => n.type === 'Pressable' && n.props.accessibilityLabel.startsWith('優先モデルにする')).length, 20);
    button(tree, '次の20件').props.onPress(); tree = e.render();
    button(tree, '優先モデルにする: vendor/model-24').props.onPress(); assert.deepEqual(e.primary, ['vendor/model-24']);
    const input = nodes(tree).find(n => n.type === 'TextInput'); input.props.onChangeText('model-0'); tree = e.render();
    button(tree, '回転に追加: vendor/model-0').props.onPress(); assert.deepEqual(e.backups, ['vendor/model-0']);
    button(tree, '無料モデルのみ: OFF').props.onPress(); tree = e.render();
    assert.equal(nodes(tree).filter(n => n.type === 'Pressable' && n.props.accessibilityLabel.startsWith('優先モデルにする')).length, 1);
    e.unmount();
});

test('key changes and unmount abort discovery and discard stale results', async () => {
    const e = setup(); let tree = e.render({ apiKey: 'old-key' });
    const pending = button(tree, 'OpenRouter のモデル一覧を取得・更新').props.onPress();
    e.render({ apiKey: 'new-key' }); assert.equal(e.calls[0].options.signal.aborted, true);
    e.finish(samples); await pending; tree = e.render();
    assert.equal(nodes(tree).some(n => n.type === 'TextInput'), false);
    const next = button(tree, 'OpenRouter のモデル一覧を取得・更新').props.onPress(); e.unmount();
    assert.equal(e.calls[1].key, 'new-key'); assert.equal(e.calls[1].options.signal.aborted, true);
    e.finish(samples); await next;
});
