const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const core = require('../src/core.cjs');
test('only intended HTTP hosts are cleaned', () => {
    for (const host of ['instagram.com', 'www.instagram.com', 'x.com', 'mobile.twitter.com', 'X.COM']) {
        assert.equal(core.cleanUrl(`https://${host}/post?igsh=123#part`), `https://${host}/post`);
    }
    for (const url of ['https://x.com.evil.test/a?q=1', 'https://evil.test/x.com?q=1', 'https://x.com@evil.test/a?q=1', 'https://example.com?q=1', 'https://x.com/a#fragment?q=1', 'https://x.com/a', 'ftp://x.com/a?q=1']) assert.equal(core.cleanUrl(url), url);
});
test('multiple links, Markdown, Japanese prose, punctuation, encoded question mark', () => {
    assert.equal(core.cleanText('見て https://instagram.com/p/a?igsh=abc。 [投稿](https://x.com/a?s=20) https://example.com/?a=1'), '見て https://instagram.com/p/a。 [投稿](https://x.com/a) https://example.com/?a=1');
    assert.equal(core.cleanText('<https://x.com/a?q=1> https://x.com/a%3Fb?q=2!'), '<https://x.com/a> https://x.com/a%3Fb!');
});
function environment(options = {}) {
    const calls = [];
    let hooks = 0;
    const messages = { sendMessage: (...args) => { calls.push(args); return 'sent'; } };
    const urls = { openURL: (...args) => { calls.push(args); return 'opened'; } };
    const taps = { handleMessagesTapURLLink: (...args) => calls.push(args), handleMessagesTapLink: (...args) => calls.push(args) };
    const clicks = { handleClick: (...args) => { calls.push(args); return 'clicked'; } };
    const commonUrls = { openURL: (...args) => { calls.push(args); return 'common-opened'; } };
    const native = { openURL: (...args) => calls.push(args) };
    const urlTaps = options.splitTaps ? { handleMessagesTapURLLink: taps.handleMessagesTapURLLink } : taps;
    const linkTaps = options.splitTaps ? { handleMessagesTapLink: taps.handleMessagesTapLink } : taps;
    const vendetta = {
        metro: { common: { ReactNative: { Linking: native }, url: options.commonAlias ? urls : commonUrls }, findByProps: (...props) => {
            const modules = [messages, urls, clicks, urlTaps];
            if (options.splitTaps) modules.push(linkTaps);
            return modules.find(module => props.every(prop => typeof module[prop] === 'function'));
        } },
        patcher: { before(name, obj, callback) {
            const original = obj[name]; hooks++;
            obj[name] = function (...args) { callback(args); return original.apply(this, args); };
            return () => { obj[name] = original; hooks--; };
        } }
    };
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    const plugin = vm.runInNewContext('(' + source + ')', { vendetta });
    return { plugin, messages, urls, taps, urlTaps, linkTaps, clicks, commonUrls, native, calls, hooks: () => hooks };
}
test('loader expression, copied send payload, lifecycle and original return values', () => {
    const e = environment(); e.plugin.onLoad(); e.plugin.onLoad(); assert.equal(e.hooks(), 7);
    const proto = { marker: true };
    const attachments = [{ id: 'attachment' }];
    const payload = Object.freeze(Object.assign(Object.create(proto), { content: 'https://x.com/post?s=1', attachments }));
    assert.equal(e.messages.sendMessage('channel', payload, { nonce: 1 }), 'sent');
    const copy = e.calls[0][1];
    assert.equal(copy.content, 'https://x.com/post'); assert.equal(payload.content, 'https://x.com/post?s=1');
    assert.equal(copy.attachments, attachments); assert.equal(Object.getPrototypeOf(copy), proto);
    assert.equal(e.urls.openURL('https://instagram.com/p/a?igsh=1', { external: true }), 'opened');
    assert.equal(e.calls[1][0], 'https://instagram.com/p/a');
    const event = Object.freeze({ nativeEvent: Object.freeze({ url: 'https://x.com/a?s=1', other: 1 }) });
    e.taps.handleMessagesTapURLLink(event);
    assert.equal(e.calls[2][0].nativeEvent.url, 'https://x.com/a'); assert.equal(event.nativeEvent.url, 'https://x.com/a?s=1');
    e.taps.handleMessagesTapLink({ url: 'https://twitter.com/a?s=2' });
    assert.equal(e.calls[3][0].url, 'https://twitter.com/a');
    e.native.openURL('https://x.com/b?q=2'); assert.equal(e.calls[4][0], 'https://x.com/b');
    e.plugin.onUnload(); e.plugin.onUnload(); assert.equal(e.hooks(), 0);
    e.messages.sendMessage('channel', payload); assert.equal(e.calls[5][1], payload);
    e.plugin.onLoad(); assert.equal(e.hooks(), 7); e.plugin.onUnload();
});
test('missing or throwing internal modules do not crash', () => {
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    for (const vendetta of [{}, { patcher: { before() {} }, metro: { findByProps() { throw Error('unavailable'); } } }]) {
        const plugin = vm.runInNewContext('(' + source + ')', { vendetta });
        plugin.onLoad(); plugin.onUnload();
    }
});
test('manifest matches expression and distribution avoids known incompatible syntax', () => {
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    const manifest = require('../manifest.json');
    assert.equal(manifest.hash, crypto.createHash('sha256').update(source).digest('hex'));
    assert.doesNotMatch(source, /\b(?:async\s+function|class\s+\w+|let\s+|const\s+)\b/);
});

test('Discord handleClick cleans href before opening and preserves arguments and return value', () => {
    const e = environment(); e.plugin.onLoad();
    const payload = Object.freeze({ href: 'https://www.instagram.com/p/ABC/?igsh=123', trusted: true });
    const context = { source: 'message' };
    assert.equal(e.clicks.handleClick(payload, context), 'clicked');
    assert.equal(e.calls[0][0].href, 'https://www.instagram.com/p/ABC/');
    assert.equal(e.calls[0][0].trusted, true);
    assert.equal(e.calls[0][1], context);
    assert.equal(payload.href, 'https://www.instagram.com/p/ABC/?igsh=123');
    const other = { href: 'https://example.com/?keep=1' };
    e.clicks.handleClick(other); assert.equal(e.calls[1][0], other);
    e.plugin.onUnload();
    e.clicks.handleClick(payload); assert.equal(e.calls[2][0], payload);
    e.plugin.onLoad(); e.clicks.handleClick(payload);
    assert.equal(e.calls[3][0].href, 'https://www.instagram.com/p/ABC/');
    e.plugin.onUnload();
});
test('supported common URL module is hooked even when findByProps returns another openURL', () => {
    const e = environment(); e.plugin.onLoad();
    assert.equal(e.commonUrls.openURL('https://x.com/a?s=1'), 'common-opened');
    assert.equal(e.calls[0][0], 'https://x.com/a');
    e.plugin.onUnload(); assert.equal(e.hooks(), 0);
    const alias = environment({ commonAlias: true }); alias.plugin.onLoad();
    assert.equal(alias.hooks(), 6); alias.plugin.onUnload(); assert.equal(alias.hooks(), 0);
});
test('native tap handlers are found independently when exports are split', () => {
    const e = environment({ splitTaps: true }); e.plugin.onLoad();
    const event = Object.freeze({ nativeEvent: Object.freeze({ url: 'https://x.com/a?s=1' }) });
    e.urlTaps.handleMessagesTapURLLink(event);
    e.linkTaps.handleMessagesTapLink({ url: 'https://twitter.com/b?s=2' });
    assert.equal(e.calls[0][0].nativeEvent.url, 'https://x.com/a');
    assert.equal(e.calls[1][0].url, 'https://twitter.com/b');
    assert.equal(event.nativeEvent.url, 'https://x.com/a?s=1');
    assert.equal(e.hooks(), 7);
    e.plugin.onUnload(); assert.equal(e.hooks(), 0);
});

test('getter-backed and inherited fields are copied without invalid descriptors', () => {
    const original = Object.freeze(Object.defineProperty({}, 'href', {
        get: () => 'https://x.com/post?tracking=1', enumerable: false,
    }));
    const copy = core.copyField(original, 'href', core.cleanUrl);
    assert.equal(copy.href, 'https://x.com/post');
    assert.equal(original.href, 'https://x.com/post?tracking=1');
    assert.equal(Object.getOwnPropertyDescriptor(copy, 'href').enumerable, false);
    const proto = { content: 'https://instagram.com/p/a?tracking=1' };
    const inherited = Object.create(proto);
    const cleaned = core.copyField(inherited, 'content', core.cleanText);
    assert.equal(cleaned.content, 'https://instagram.com/p/a');
    assert.equal(inherited.content, proto.content);
    assert.equal(Object.getPrototypeOf(cleaned), proto);
});

test('getter-backed link payload reaches the original click handler', () => {
    const e = environment(); e.plugin.onLoad();
    const original = Object.freeze({ get href() { return 'https://x.com/post?tracking=1'; } });
    assert.equal(e.clicks.handleClick(original), 'clicked');
    assert.equal(e.calls[0][0].href, 'https://x.com/post');
    assert.equal(original.href, 'https://x.com/post?tracking=1');
    e.plugin.onUnload();
});
