const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequestStatistics } = require('../src/core.cjs');
function setup(scheme = 'dark') {
    let cursor = 0; const slots = [], effects = [], timers = new Set(), alerts = [];
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
        useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i].deps[n])) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    };
    const create = vm.runInNewContext(fs.readFileSync(require.resolve('../src/statistics-ui.js'), 'utf8') + '\ncreateStatisticsScreen;', {
        setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    });
    const RN = { View: 'View', Text: 'Text', Pressable: 'Pressable', useColorScheme: () => scheme, Alert: { alert: (...args) => alerts.push(args) } };
    const statistics = createRequestStatistics();
    const Screen = create({ metro: { common: { React, ReactNative: RN } } });
    return { statistics, timers, alerts, render() { cursor = 0; const tree = Screen({ statistics }); effects.splice(0).forEach(fn => fn()); return tree; }, tick() { timers.forEach(fn => fn()); }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)]; }
const content = tree => nodes(tree).filter(node => node.type === 'Text').map(node => node.children.flat().join('')).join('\n');
const button = (tree, label) => nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);

test('statistics screen has empty state, live updates, filters, accessible charts, and cleans up polling', () => {
    for (const scheme of ['dark', 'light']) {
        const e = setup(scheme); let tree = e.render();
        assert.match(content(tree), /まだ送信記録がありません/);
        e.statistics.start({ provider: 'gemini', model: 'shared-model', texts: 8, characters: 80 })('success');
        e.statistics.start({ provider: 'openrouter', model: 'shared-model', texts: 2, characters: 20 })('failed');
        e.tick(); tree = e.render();
        assert.match(content(tree), /50%/);
        assert.ok(button(tree, 'Gemini、1 回、50%、モデルを表示'));
        button(tree, 'Gemini').props.onPress(); tree = e.render();
        assert.equal(button(tree, 'Gemini').props.accessibilityState.selected, true);
        assert.match(content(tree), /100%/);
        assert.equal(nodes(tree).filter(node => node.type === 'Text' && node.children[0] === 'shared-model').length, 1);
        button(tree, '今日').props.onPress(); tree = e.render();
        assert.equal(button(tree, '今日').props.accessibilityState.selected, true);
        assert.equal(e.timers.size, 1);
        e.unmount(); assert.equal(e.timers.size, 0);
    }
});
test('model pagination and reset confirmation remove aggregates without accepting old completions', () => {
    const e = setup();
    for (let i = 0; i < 17; i++) e.statistics.start({ provider: 'gemini', model: `model-${i}`, texts: 1, characters: 5 })('success');
    let tree = e.render();
    assert.equal(button(tree, '前の15件').props.disabled, true);
    button(tree, '次の15件').props.onPress(); tree = e.render();
    assert.equal(button(tree, '次の15件').props.disabled, true);
    const finish = e.statistics.start({ provider: 'deepl', model: '', texts: 1, characters: 2 });
    button(tree, '統計をリセット').props.onPress();
    assert.equal(e.statistics.snapshot().total.sent, 18);
    e.alerts[0][2][1].onPress(); finish('success'); tree = e.render();
    assert.match(content(tree), /まだ送信記録がありません/);
    assert.equal(e.statistics.snapshot().total.sent, 0);
    e.unmount();
});
