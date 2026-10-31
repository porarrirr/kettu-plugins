const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Translator, DEFAULTS, makeRequest, normalizeConfig, parseTranslation, candidates } = require('../src/core.cjs');
const config = extra => ({ ...DEFAULTS, provider: 'openrouter', openrouterKey: 'router-key', openrouterModel: 'google/example:free', ...extra });
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 0, text }] }) } }] });
const response = (status, data) => ({ ok: status === 200, status, json: async () => data });
const model = (id, extra = {}) => ({ id, name: id, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['response_format'], pricing: { prompt: '0', completion: '0' }, top_provider: { max_completion_tokens: 8192 }, ...extra });

test('OpenRouter uses chat completions, bearer key, JSON output and compatible provider routing', () => {
    const request = makeRequest(['Hello', 'Bye'], normalizeConfig(config()));
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer router-key');
    assert.equal(request.body.model, 'google/example:free');
    assert.deepEqual(request.body.provider, { require_parameters: true });
    assert.equal(request.body.response_format.type, 'json_object');
    assert.equal(request.body.max_tokens, 8192);
    assert.deepEqual(JSON.parse(request.body.messages[1].content).items, [{ id: 0, text: 'Hello' }, { id: 1, text: 'Bye' }]);
    assert.deepEqual(parseTranslation(reply('こんにちは'), 'openrouter'), ['こんにちは']);
    assert.throws(() => parseTranslation({ choices: [{ finish_reason: 'length' }] }, 'openrouter'), /途中/);
});

test('OpenRouter model/key rotation, 429 failover and namespace preservation share the translation engine', async () => {
    const c = config({ openrouterModel: 'models/primary', openrouterBackupModels: 'google/backup:free', openrouterBackupKeys: ['backup-key'] });
    assert.equal(candidates(c)[0].openrouterModel, 'models/primary');
    let clock = 0;
    const requests = [];
    const engine = new Translator({ now: () => clock, random: () => 0, sleep: async ms => { clock += ms; }, fetch: async (url, options) => {
        requests.push({ url, key: options.headers.Authorization, body: JSON.parse(options.body) });
        return requests.length === 1 ? response(429, {}) : response(200, reply('訳'));
    } });
    assert.equal(await engine.translate('Hello', c), '訳');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.model, 'models/primary');
    assert.equal(requests[1].body.model, 'models/primary');
    assert.equal(requests[1].key, 'Bearer backup-key');
    await engine.translate('Another', c);
    assert.equal(requests[2].body.model, 'google/backup:free');
    engine.dispose();
});

test('public catalog filters nontext/nonJSON/small output models, deduplicates and does not invent free prices', async () => {
    const requests = [];
    const engine = new Translator({ fetch: async (url, options) => {
        requests.push({ url, options });
        return response(200, { data: [model('valid'), model('valid'), model('paid', { pricing: { prompt: '0.000001', completion: '0.000002' } }),
            model('unknown-price', { pricing: {} }), model('image', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
            model('no-json', { supported_parameters: [] }), model('too-small', { top_provider: { max_completion_tokens: 4096 } }), null] });
    } });
    const values = await engine.listOpenRouterModels();
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/models');
    assert.equal(requests[0].options.headers.Authorization, undefined);
    assert.deepEqual(values.map(v => v.id), ['paid', 'unknown-price', 'valid']);
    assert.equal(values.find(v => v.id === 'valid').free, true);
    assert.equal(values.find(v => v.id === 'unknown-price').free, false);
    engine.dispose();
});

test('keyed model discovery uses user preferences and never falls back to the unrestricted catalog on rejection', async () => {
    const requests = [];
    const engine = new Translator({ fetch: async (url, options) => { requests.push({ url, options }); return response(401, {}); } });
    await assert.rejects(engine.listOpenRouterModels('  private-key  '), /HTTP 401/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/models/user');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer private-key');
    assert.equal(engine.blocked.size, 0);
    engine.dispose();
});

test('model discovery rejects malformed responses and hides raw network errors', async () => {
    const engine = new Translator({ fetch: async () => response(200, { data: {} }) });
    await assert.rejects(engine.listOpenRouterModels(), /形式が不正/);
    engine.fetch = async () => { throw new Error('private-key'); };
    await assert.rejects(engine.listOpenRouterModels(), error => !error.message.includes('private-key'));
    engine.dispose();
});

test('external abort and plugin unload cancel model discovery including its response body', async () => {
    for (const unload of [false, true]) {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const engine = new Translator({ fetch: async (url, options) => {
            started();
            return { ok: true, json: () => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new Error('aborted')));
            }) };
        } });
        const controller = new AbortController();
        const pending = engine.listOpenRouterModels('', { signal: controller.signal });
        await ready; await Promise.resolve();
        if (unload) engine.dispose(); else controller.abort();
        await assert.rejects(pending, /中断|停止/);
        assert.equal(engine.controllers.size, 0);
        engine.dispose();
    }
});
