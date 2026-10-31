const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Translator, DEFAULTS, createRequestStatistics } = require('../src/core.cjs');
const config = { ...DEFAULTS, deeplKey: 'private-key', intervalMs: 1000 };
const ok = { ok: true, status: 200, json: async () => ({ translations: [{ text: '訳' }] }) };
const event = extra => ({ provider: 'gemini', model: 'model-a', texts: 2, characters: 12, ...extra });
function harness() {
    let saved, clock = new Date(2026, 9, 16, 12).getTime();
    const options = { now: () => clock, load: () => saved, save: value => { saved = structuredClone(value); } };
    return { statistics: createRequestStatistics(options), options, advance: days => { const date = new Date(clock); date.setDate(date.getDate() + days); clock = date.getTime(); }, get saved() { return saved; } };
}
test('statistics count batches, fallbacks, validation failures and transport failures by actual destination', async () => {
    const e = harness(); let n = 0;
    const engine = new Translator({ sleep: async () => {}, onRequest: value => e.statistics.start(value), fetch: async () => ++n === 1 ? { ok: false, status: 429, json: async () => ({}) } : ok });
    await engine.run(['hello'], { ...config, deeplBackupKeys: ['private-backup'] }, () => {});
    assert.equal(e.statistics.snapshot().total.sent, 2);
    assert.equal(e.statistics.snapshot().total.success, 1);
    assert.equal(e.statistics.snapshot().total.failed, 1);
    engine.dispose();
    const malformed = new Translator({ onRequest: value => e.statistics.start(value), fetch: async () => ({ ...ok, json: async () => ({ translations: [] }) }) });
    await assert.rejects(malformed.run(['hello'], config, () => {}));
    malformed.dispose();
    const failed = new Translator({ onRequest: value => e.statistics.start(value), fetch: async () => { throw Error('offline'); } });
    await assert.rejects(failed.run(['hello'], config, () => {}));
    assert.equal(e.statistics.snapshot().total.failed, 3);
    assert.equal(e.statistics.snapshot().total.texts, 4);
    assert.equal(JSON.stringify(e.saved).includes('private'), false);
    assert.equal(JSON.stringify(e.saved).includes('hello'), false);
    failed.dispose();
});
test('cached, shared, Japanese, cancelled-before-send and catalog requests do not inflate translation counts', async () => {
    const e = harness(); let calls = 0;
    const engine = new Translator({ sleep: async () => {}, onRequest: value => e.statistics.start(value), fetch: async () => { calls++; return ok; } });
    await Promise.all([engine.translate('hello', config), engine.translate('hello', config)]);
    await engine.translate('hello', config);
    await engine.translate('hello日本', config);
    await assert.rejects(engine.translate('not visible', config, () => {}, { shouldSend: () => false }));
    assert.equal(calls, 1); assert.equal(e.statistics.snapshot().total.sent, 1);
    engine.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    await engine.listOpenRouterModels();
    assert.equal(e.statistics.snapshot().total.sent, 1);
    engine.dispose();
});
test('statistics distinguish identical model IDs across providers, date ranges, and filter totals', () => {
    const e = harness();
    e.statistics.start(event())('success');
    e.advance(1); e.statistics.start(event({ provider: 'openrouter' }))('failed');
    e.advance(6); e.statistics.start(event({ model: 'model-b' }))('interrupted');
    assert.equal(e.statistics.snapshot(1).total.sent, 1);
    assert.equal(e.statistics.snapshot(7).total.sent, 2);
    assert.equal(e.statistics.snapshot(30).models.length, 3);
    assert.equal(e.statistics.snapshot(30, 'gemini').total.sent, 2);
    assert.equal(e.statistics.snapshot(30, 'gemini').providers.length, 2);
    const copy = e.statistics.snapshot(); copy.total.sent = 999;
    assert.equal(e.statistics.snapshot().total.sent, 3);
    const restored = createRequestStatistics(e.options);
    assert.deepEqual(restored.snapshot(), e.statistics.snapshot());
    e.advance(30); assert.equal(e.statistics.snapshot().total.sent, 0);
});
test('reset invalidates old completions and app restart marks unfinished sends unknown', () => {
    const e = harness(); const finish = e.statistics.start(event());
    assert.equal(e.statistics.snapshot().total.sent, 1);
    const restored = createRequestStatistics(e.options);
    assert.equal(restored.snapshot().total.interrupted, 1);
    e.statistics.clear();
    e.statistics.start(event({ model: 'new' }))('success');
    finish('success'); finish('failed');
    assert.equal(e.statistics.snapshot().total.sent, 1);
    assert.equal(e.statistics.snapshot().total.success, 1);
    assert.equal(e.saved.rows.length, 1);
    assert.equal(e.saved.rows[0].model, 'new');
});
test('unload records interruption once and ignores a late successful network response', async () => {
    const e = harness(); let resolve;
    const engine = new Translator({ onRequest: value => e.statistics.start(value), fetch: () => new Promise(yes => { resolve = yes; }) });
    const pending = engine.run(['hello'], config, () => {});
    assert.equal(e.statistics.snapshot().total.sent, 1);
    engine.dispose(); await assert.rejects(pending);
    resolve(ok); await new Promise(yes => setImmediate(yes));
    assert.equal(e.statistics.snapshot().total.interrupted, 1);
    assert.equal(e.statistics.snapshot().total.success, 0);
});
test('statistics ignore damaged data, whitelist fields, bound storage, and tolerate storage failures', () => {
    const e = harness(); e.statistics.start(event())('success');
    const row = e.saved.rows[0]; let saved;
    const stats = createRequestStatistics({ ...e.options, load: () => ({ version: 1, rows: [{ ...row, secret: 'do not copy' }, { ...row, sent: -1 }, { ...row, failed: 10 }, null] }), save: value => { saved = value; } });
    assert.equal(stats.snapshot().total.sent, 1);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
    for (let i = 0; i < 3005; i++) stats.start(event({ model: `m-${i}` }))('success');
    assert.equal(saved.rows.length, 3000);
    const broken = createRequestStatistics({ load() { throw Error(); }, save() { throw Error(); } });
    broken.start(event())('success'); assert.equal(broken.snapshot().total.sent, 1);
});

test('a timed-out attempt and successful fallback keep distinct results after a late response', async () => {
    const e = harness(); let late, timeout;
    const engine = new Translator({ onRequest: value => e.statistics.start(value),
        setTimer: fn => { timeout = fn; return fn; }, clearTimer() {},
        fetch: url => url.includes('deepl') ? new Promise(resolve => { late = resolve; }) : Promise.resolve({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"translations":[{"id":0,"text":"訳"}]}' }] } }] }) }),
    });
    const pending = engine.run(['hello'], { ...config, geminiKey: 'mock', geminiModel: 'fallback-model' }, () => {});
    timeout(); await pending;
    late(ok); await new Promise(resolve => setImmediate(resolve));
    const data = e.statistics.snapshot();
    assert.equal(data.models.find(row => row.provider === 'deepl').failed, 1);
    assert.equal(data.models.find(row => row.model === 'fallback-model').success, 1);
    assert.equal(data.total.sent, 2); assert.equal(data.total.success, 1);
    engine.dispose();
});
