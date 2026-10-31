const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Translator, DEFAULTS, normalizeConfig, createRequestStatistics } = require('../src/core.cjs');
const config = (provider, extra = {}) => normalizeConfig({ ...DEFAULTS, provider,
    geminiKey: 'g-key', geminiModel: 'g-main', geminiBackupModels: 'g-second,g-third',
    openrouterKey: 'r-key', openrouterModel: 'vendor/main', openrouterBackupModels: 'vendor/second,vendor/third', ...extra });
const response = (status, data = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data, headers: { get: name => headers[name] } });
function success(provider, texts = ['訳']) {
    const text = JSON.stringify({ translations: texts.map((value, id) => ({ id, text: value })).reverse() });
    return response(200, provider === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] } : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
}
function harness(reply) {
    let clock = 0; const calls = [], waits = [], reports = [];
    const statistics = createRequestStatistics();
    const engine = new Translator({ now: () => clock, random: () => 0, sleep: async ms => { waits.push(ms); clock += ms; },
        onRequest: event => statistics.start(event), fetch: async (url, options) => {
            const provider = url.includes('openrouter') ? 'openrouter' : 'gemini';
            const model = provider === 'gemini' ? decodeURIComponent(url.match(/models\/(.*):/)[1]) : JSON.parse(options.body).model;
            calls.push({ provider, model, at: clock });
            return reply({ provider, model, options, count: calls.length, advance: ms => { clock += ms; } });
        } });
    return { engine, calls, waits, statistics, run: (c, texts = ['hello']) => engine.run(texts, c, (message, detail) => reports.push({ message, detail })), reports };
}

test('OpenRouter HTTP 200 error envelopes switch immediately to Gemini and remain failed in statistics', async () => {
    for (const code of [429, 502, '503', undefined]) {
        const e = harness(({ provider, count }) => count === 1 ? response(200, { error: { code, metadata: { error_type: code === undefined ? 'provider_unavailable' : undefined } } }) : success(provider));
        assert.deepEqual(await e.run(config('openrouter')), ['訳']);
        assert.deepEqual(e.calls.map(row => row.provider), ['openrouter', 'gemini']);
        assert.equal(e.calls[1].at - e.calls[0].at, 0);
        assert.equal(e.statistics.snapshot().total.failed, 1); assert.equal(e.statistics.snapshot().total.success, 1);
        assert.ok(e.reports.some(row => row.message.includes(`HTTP ${code === undefined ? 503 : code}`)));
        e.engine.dispose();
    }
});
test('Gemini and OpenRouter failures prefer the other ready provider over their own ready backup models', async () => {
    for (const provider of ['gemini', 'openrouter']) {
        const e = harness(({ provider, count, advance }) => { if (count === 1) { advance(4000); return response(503); } return success(provider); });
        await e.run(config(provider));
        assert.deepEqual(e.calls.map(row => row.provider), [provider, provider === 'gemini' ? 'openrouter' : 'gemini']);
        assert.equal(e.calls[1].at - e.calls[0].at, 4000);
        assert.deepEqual(e.waits, []);
        e.engine.dispose();
    }
});
test('HTTP 408 and model configuration failures switch destinations without retrying unchanged requests', async () => {
    for (const provider of ['gemini', 'openrouter']) for (const status of [400, 404, 408, 422]) {
        const e = harness(({ provider, count }) => count === 1 ? response(status) : success(provider));
        await e.run(config(provider));
        assert.equal(e.calls.length, 2); assert.notEqual(e.calls[0].provider, e.calls[1].provider);
        assert.equal(e.calls[1].at - e.calls[0].at, 0);
        assert.equal(e.engine.blockedModels.size, status === 408 ? 0 : 1);
        e.engine.dispose();
    }
});
test('a different model on the same key starts after a 1 second floor on failure, even with a 60 second normal interval', async () => {
    for (const provider of ['gemini', 'openrouter']) {
        const e = harness(({ provider, count }) => count === 1 ? response(503) : success(provider));
        await e.run(config(provider, { autoSwitch: false, intervalMs: 60000 }));
        assert.equal(e.calls.length, 2); assert.equal(e.calls[0].provider, e.calls[1].provider);
        assert.notEqual(e.calls[0].model, e.calls[1].model);
        assert.equal(e.calls[1].at - e.calls[0].at, 1000);
        // Successful requests retain the configured ordinary spacing.
        await e.run(config(provider, { autoSwitch: false, intervalMs: 60000 }));
        assert.equal(e.calls[2].at - e.calls[1].at, 60000);
        e.engine.dispose();
    }
});
test('a ready local model is used instead of waiting for an independent provider in cooldown', async () => {
    const e = harness(({ provider, count }) => count === 1 ? response(503) : success(provider));
    const c = config('gemini');
    e.engine.nextAt.set(JSON.stringify(['openrouter', c.openrouterKey]), 90000);
    await e.run(c);
    assert.deepEqual(e.calls.map(row => row.model), ['g-main', 'g-second']);
    assert.equal(e.calls[1].at, 1000);
    e.engine.dispose();
});
test('bad JSON IDs and truncated translations fall back as one batch and never reuse unvalidated output', async () => {
    for (const provider of ['gemini', 'openrouter']) {
        const e = harness(({ provider, count }) => {
            if (count === 1) return response(200, provider === 'gemini'
                ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"translations":[{"id":99,"text":"wrong"}]}' }] } }] }
                : { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] });
            return success(provider, ['一', '二']);
        });
        assert.deepEqual(await e.run(config(provider), ['one', 'two']), ['一', '二']);
        assert.equal(e.calls.length, 2); assert.notEqual(e.calls[0].provider, e.calls[1].provider);
        assert.equal(e.statistics.snapshot().total.failed, 1);
        e.engine.dispose();
    }
});
test('with no alternate candidate, an invalid output stops once instead of resending', async () => {
    const e = harness(() => response(200, { choices: [{ finish_reason: 'length' }] }));
    await assert.rejects(e.run(config('openrouter', { autoSwitch: false, modelRotation: false })), /途中/);
    assert.equal(e.calls.length, 1); e.engine.dispose();
});
test('OpenRouter 429 switches at headers without awaiting its stalled error body and preserves Retry-After', async () => {
    let reads = 0;
    const e = harness(({ provider, count }) => count === 1 ? { ...response(429, {}, { 'Retry-After': '90' }), json() { reads++; return new Promise(() => {}); } } : success(provider));
    await e.run(config('openrouter'));
    assert.equal(reads, 0); assert.equal(e.calls[1].at, e.calls[0].at);
    assert.ok([...e.engine.cooldown.values()].includes(90000));
    e.engine.dispose();
});
test('Gemini RetryInfo still applies to the failed candidate after a faster model switch', async () => {
    const e = harness(({ provider, count }) => count === 1 ? response(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '90s' }] } }) : success(provider));
    await e.run(config('gemini', { autoSwitch: false }));
    assert.equal(e.calls[1].at, 1000);
    assert.ok([...e.engine.cooldown.values()].includes(90000));
    assert.notEqual(e.calls[1].model, e.calls[0].model);
    e.engine.dispose();
});
test('temporary OpenRouter in-flight budget limits do not permanently disable a credential', async () => {
    const e = harness(({ provider, count }) => count === 1 ? response(402, { error: { metadata: { limit_source: 'openrouter_in_flight_budget' } } }, { 'Retry-After': '30' }) : success(provider));
    await e.run(config('openrouter'));
    assert.equal(e.engine.blocked.size, 0);
    assert.ok([...e.engine.cooldown.values()].includes(30000));
    assert.equal(e.calls[1].provider, 'gemini'); e.engine.dispose();
});
test('OpenRouter error envelopes take precedence over apparently successful choices', async () => {
    const misleading = await success('openrouter').json();
    const e = harness(({ provider, count }) => count === 1 ? response(200, { ...misleading, error: { code: 503 } }) : success(provider));
    await e.run(config('openrouter'));
    assert.equal(e.calls.length, 2); assert.equal(e.statistics.snapshot().total.failed, 1);
    e.engine.dispose();
});

test('Gemini stalled RetryInfo body is bounded to 100 ms, including a ready independent provider', async () => {
    let now = 0, next = 0; const timers = new Map(), calls = [];
    const engine = new Translator({ now: () => now, random: () => 0,
        setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id),
        fetch: async url => { calls.push({ at: now, url }); return calls.length === 1 ? { ...response(429, {}, { 'Retry-After': '90' }), json: () => new Promise(() => {}) } : success('openrouter'); } });
    const pending = engine.run(['hello'], config('gemini'), () => {});
    for (let i = 0; i < 30 && ![...timers.values()].some(timer => timer.ms === 100); i++) await Promise.resolve();
    const deadline = [...timers.values()].find(timer => timer.ms === 100); assert.ok(deadline);
    now += 100; deadline.fn();
    assert.deepEqual(await pending, ['訳']);
    assert.equal(calls[1].at - calls[0].at, 100);
    assert.ok([...engine.cooldown.values()].some(value => value >= 90000));
    assert.equal(timers.size, 0); engine.dispose();
});

test('the built Kettu expression switches between OpenRouter and Gemini and records the failing model', async () => {
    const vm = require('node:vm'), fs = require('node:fs');
    const bundle = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    for (const initial of ['gemini', 'openrouter']) {
        const storage = config(initial), calls = []; let command;
        const vendetta = { plugin: { storage }, metro: { common: { React: { createElement() {} }, ReactNative: {}, clipboard: { setString() {} } } },
            ui: { toasts: { showToast() {} } }, commands: { registerCommand: value => { command = value; return () => {}; } } };
        const plugin = vm.runInNewContext(bundle, { vendetta, AbortController, setTimeout, clearTimeout,
            fetch: async url => {
                const provider = url.includes('openrouter') ? 'openrouter' : 'gemini'; calls.push(provider);
                if (calls.length === 1) return provider === 'openrouter' ? response(200, { error: { code: 503 } }) : response(408);
                return success(provider);
            } });
        plugin.onLoad();
        assert.equal(await command.execute([{ name: 'text', value: 'hello' }]), undefined);
        assert.deepEqual(calls, [initial, initial === 'gemini' ? 'openrouter' : 'gemini']);
        const failed = storage.requestStatistics.rows.find(row => row.failed === 1);
        assert.equal(failed.provider, initial); assert.equal(failed.model, initial === 'gemini' ? 'g-main' : 'vendor/main');
        assert.equal(storage.requestStatistics.rows.reduce((total, row) => total + row.success, 0), 1);
        plugin.onUnload();
    }
});

test('fast model switching never shortens server Retry-After before reusing the same candidate', async () => {
    for (const provider of ['gemini', 'openrouter']) {
        const e = harness(({ provider, count }) => count === 1 ? response(429, {}, { 'Retry-After': '90' }) : success(provider));
        await e.run(config(provider, { autoSwitch: false, modelRotation: false }));
        assert.equal(e.calls[1].at - e.calls[0].at, 90000);
        assert.equal(e.calls[0].model, e.calls[1].model);
        e.engine.dispose();
    }
});
test('losing viewport relevance after an error stops the newly selected fallback before sending', async () => {
    let visible = true, calls = 0;
    const engine = new Translator({ fetch: async () => { calls++; return response(503); } });
    await assert.rejects(engine.run(['hello'], config('openrouter'), () => { if (calls) visible = false; }, () => visible), /表示範囲外/);
    assert.equal(calls, 1); engine.dispose();
});
