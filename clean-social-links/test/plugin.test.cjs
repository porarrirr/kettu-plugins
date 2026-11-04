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
    let settingState;
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: value => {
            if (settingState === undefined) settingState = value;
            return [settingState, next => { settingState = next; }];
        }
    };
    const vendetta = {
        plugin: { storage: options.storage || {} },
        metro: { common: { React, ReactNative: { View: "View", Text: "Text", Switch: "Switch", ScrollView: "ScrollView", useColorScheme: () => "light", Linking: native }, url: options.commonAlias ? urls : commonUrls }, findByProps: (...props) => {
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
        assert.equal(plugin.settings(), null);
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


test('Amazon regional and short URLs are cleaned with exact host boundaries', () => {
    const domains = ['amazon.co.jp', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.in', 'amazon.com.br', 'amazon.com.mx', 'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be', 'amazon.ie', 'amazon.com.tr', 'amazon.ae', 'amazon.sa', 'amazon.sg', 'amazon.eg', 'amazon.co.za', 'amazon.cn', 'amzn.asia', 'amzn.to'];
    for (const domain of domains) {
        for (const host of [domain, 'www.' + domain, domain.toUpperCase()]) {
            assert.equal(core.cleanUrl(`https://${host}/dp/B012345678?tag=test&ref_=share#part`), `https://${host}/dp/B012345678`);
        }
    }
    assert.equal(core.cleanUrl('http://www.amazon.co.jp:80/dp/B012345678?tag=test'), 'http://www.amazon.co.jp:80/dp/B012345678');
    for (const url of ['https://amazon.co.jp.evil.test/dp/id?tag=test', 'https://amazon.com@evil.test/?tag=test', 'https://notamazon.com/?tag=test', 'https://amazon.evil/?tag=test', 'https://amzn.to.evil.test/?tag=test', 'https://amzn.asia@evil.test/?tag=test', 'ftp://amazon.co.jp/dp/id?tag=test', 'https://amazon.co.jp/dp/id#part?keep=1', 'https://amzn.asia/d/abc', 'https://example.com/?amazon=1']) {
        assert.equal(core.cleanUrl(url), url);
    }
    assert.equal(core.cleanText('商品 [Amazon](https://www.amazon.co.jp/dp/B012345678?tag=test)。 <https://amzn.asia/d/abc?share=1> https://amzn.to/abc?tag=test! https://example.com/?keep=1'), '商品 [Amazon](https://www.amazon.co.jp/dp/B012345678)。 <https://amzn.asia/d/abc> https://amzn.to/abc! https://example.com/?keep=1');
});

test('Amazon links are cleaned on send and open and restored on unload', () => {
    const e = environment(); e.plugin.onLoad();
    const payload = Object.freeze({ content: 'https://www.amazon.co.jp/dp/B012345678?tag=test https://amzn.asia/d/abc?share=1' });
    assert.equal(e.messages.sendMessage('channel', payload), 'sent');
    assert.equal(e.calls[0][1].content, 'https://www.amazon.co.jp/dp/B012345678 https://amzn.asia/d/abc');
    assert.equal(payload.content, 'https://www.amazon.co.jp/dp/B012345678?tag=test https://amzn.asia/d/abc?share=1');
    const link = Object.freeze({ href: 'https://amazon.com/dp/B012345678?tag=test' });
    e.clicks.handleClick(link);
    assert.equal(e.calls[1][0].href, 'https://amazon.com/dp/B012345678');
    const event = Object.freeze({ nativeEvent: Object.freeze({ url: 'https://amzn.to/abc?tag=test' }) });
    e.taps.handleMessagesTapURLLink(event);
    assert.equal(e.calls[2][0].nativeEvent.url, 'https://amzn.to/abc');
    assert.equal(event.nativeEvent.url, 'https://amzn.to/abc?tag=test');
    e.urls.openURL('https://www.amazon.co.jp/dp/B012345678?tag=test');
    assert.equal(e.calls[3][0], 'https://www.amazon.co.jp/dp/B012345678');
    e.plugin.onUnload();
    e.clicks.handleClick(link); assert.equal(e.calls[4][0], link);
    e.messages.sendMessage('channel', payload); assert.equal(e.calls[5][1], payload);
});


test('fxtwitter replacement is opt-in and only replaces exact X/Twitter hosts', () => {
    for (const host of ['x.com', 'X.COM', 'www.x.com', 'mobile.twitter.com', 'twitter.com']) {
        assert.equal(core.cleanUrl(`https://${host}/user/status/123?s=20`), `https://${host}/user/status/123`);
        assert.equal(core.cleanUrl(`https://${host}/user/status/123?s=20`, true), 'https://fxtwitter.com/user/status/123');
    }
    assert.equal(core.cleanUrl('http://x.com:80/a#part?keep=1', true), 'http://fxtwitter.com:80/a#part?keep=1');
    assert.equal(core.cleanUrl('https://x.com', true), 'https://fxtwitter.com');
    for (const url of ['https://x.com.evil.test/a?q=1', 'https://x.com@evil.test/a?q=1', 'https://notx.com/a?q=1', 'ftp://x.com/a?q=1', 'https://fxtwitter.com/a', 'https://example.com/x.com?q=1']) {
        assert.equal(core.cleanUrl(url, true), url);
    }
    assert.equal(core.cleanText('[投稿](https://x.com/a?q=1) https://twitter.com/b! https://instagram.com/p/c?q=1 https://amazon.co.jp/dp/a?tag=1', true), '[投稿](https://fxtwitter.com/a) https://fxtwitter.com/b! https://instagram.com/p/c https://amazon.co.jp/dp/a');
});

test('settings switch defaults off, saves immediately, and persists through reload', () => {
    const storage = { unrelated: 'keep' };
    const e = environment({ storage });
    assert.equal(storage.replaceXWithFxTwitter, false);
    e.plugin.onLoad();
    e.urls.openURL('https://x.com/a?q=1');
    assert.equal(e.calls.pop()[0], 'https://x.com/a');
    const getSwitch = () => {
        return settingSwitch(e, 'Xをfxtwitterに置き換える');
    };
    assert.equal(getSwitch().props.value, false);
    getSwitch().props.onValueChange(true);
    assert.equal(storage.replaceXWithFxTwitter, true);
    assert.equal(getSwitch().props.value, true);
    e.urls.openURL('https://x.com/a?q=1');
    assert.equal(e.calls.pop()[0], 'https://fxtwitter.com/a');
    getSwitch().props.onValueChange(false);
    e.urls.openURL('https://x.com/a?q=1');
    assert.equal(e.calls.pop()[0], 'https://x.com/a');
    getSwitch().props.onValueChange(true);
    e.plugin.onUnload();
    const reloaded = environment({ storage });
    assert.equal(settingSwitch(reloaded, 'Xをfxtwitterに置き換える').props.value, true);
    reloaded.plugin.onLoad();
    reloaded.urls.openURL('https://twitter.com/a?q=1');
    assert.equal(reloaded.calls.pop()[0], 'https://fxtwitter.com/a');
    assert.equal(storage.unrelated, 'keep');
    reloaded.plugin.onUnload();
});

test('enabled replacement covers send and all open paths, preserving original objects and unload behavior', () => {
    const e = environment({ storage: { replaceXWithFxTwitter: true } });
    e.plugin.onLoad(); e.plugin.onLoad(); assert.equal(e.hooks(), 7);
    const payload = Object.freeze({ content: '[投稿](https://x.com/a?q=1)', attachments: [] });
    e.messages.sendMessage('channel', payload);
    assert.equal(e.calls.pop()[1].content, '[投稿](https://fxtwitter.com/a)');
    assert.equal(payload.content, '[投稿](https://x.com/a?q=1)');
    for (const api of [e.urls, e.commonUrls, e.native]) {
        api.openURL('https://x.com/a?q=1');
        assert.equal(e.calls.pop()[0], 'https://fxtwitter.com/a');
    }
    const link = Object.freeze({ href: 'https://twitter.com/a?q=1', trusted: true });
    e.clicks.handleClick(link);
    assert.equal(e.calls.pop()[0].href, 'https://fxtwitter.com/a');
    assert.equal(link.href, 'https://twitter.com/a?q=1');
    for (const name of ['handleMessagesTapLink', 'handleMessagesTapURLLink']) {
        const event = Object.freeze({ nativeEvent: Object.freeze({ url: 'https://x.com/a?q=1' }) });
        e.taps[name](event);
        assert.equal(e.calls.pop()[0].nativeEvent.url, 'https://fxtwitter.com/a');
        assert.equal(event.nativeEvent.url, 'https://x.com/a?q=1');
    }
    e.plugin.onUnload(); assert.equal(e.hooks(), 0);
    e.urls.openURL('https://x.com/a?q=1'); assert.equal(e.calls.pop()[0], 'https://x.com/a?q=1');
    e.plugin.onLoad();
    e.urls.openURL('https://x.com/a?q=1'); assert.equal(e.calls.pop()[0], 'https://fxtwitter.com/a');
    e.plugin.onUnload();
});


test('AliExpress item URLs remove query strings on verified domains and preserve host/path', () => {
    for (const host of ['aliexpress.com', 'www.aliexpress.com', 'ja.aliexpress.com', 'm.aliexpress.com', 'www.aliexpress.us', 'aliexpress.ru', 'ALIEXPRESS.COM']) {
        const url = `https://${host}/item/1005001234567890.html?spm=test&aff_fcid=example&sku_id=123#part`;
        assert.equal(core.cleanUrl(url), `https://${host}/item/1005001234567890.html`);
        assert.equal(core.cleanUrl(url, true), `https://${host}/item/1005001234567890.html`);
    }
    assert.equal(core.cleanUrl('http://www.aliexpress.com:80/item/123.html/?spm=test'), 'http://www.aliexpress.com:80/item/123.html/');
    assert.equal(core.cleanText('商品 [Ali](https://ja.aliexpress.com/item/123.html?spm=test)。 <https://www.aliexpress.us/item/456.html?aff_trace_key=example> https://x.com/a?q=1', true), '商品 [Ali](https://ja.aliexpress.com/item/123.html)。 <https://www.aliexpress.us/item/456.html> https://fxtwitter.com/a');
});

test('AliExpress short links, redirects, functional pages, fragments and lookalikes stay intact', () => {
    const urls = [
        'https://a.aliexpress.com/_example?spm=test',
        'https://s.click.aliexpress.com/e/_example?aff_fcid=test',
        'https://s.click.aliexpress.com/deep_link.htm?dl_target_url=https%3A%2F%2Fwww.aliexpress.com%2Fitem%2F123.html&aff_short_key=example',
        'https://a.aliexpress.com/item/123.html?keep=1',
        'https://s.click.aliexpress.com/item/123.html?keep=1',
        'https://www.aliexpress.com/wholesale?SearchText=usb&spm=test',
        'https://www.aliexpress.com/w/wholesale-usb.html?page=2&spm=test',
        'https://www.aliexpress.com/p/landing/index.html?productIds=123',
        'https://www.aliexpress.com/item/123.html/_____tmd_____/punish?x5secdata=test',
        'https://www.aliexpress.com/?productId=123',
        'https://www.aliexpress.com/item/123.html#part?keep=1',
        'https://www.aliexpress.com/item/123.html',
        'https://aliexpress.com.evil.test/item/123.html?spm=test',
        'https://aliexpress.com@evil.test/item/123.html?spm=test',
        'https://notaliexpress.com/item/123.html?spm=test',
        'https://aliexpress.com:invalid/item/123.html?spm=test',
        'https://aliexpress.example/item/123.html?spm=test',
        'ftp://aliexpress.com/item/123.html?spm=test'
    ];
    for (const url of urls) {
        assert.equal(core.cleanUrl(url), url);
        assert.equal(core.cleanUrl(url, true), url);
        assert.equal(core.cleanText(`[link](${url})`), `[link](${url})`);
    }
});

test('AliExpress cleaning covers send and all link paths without changing original payloads', () => {
    const e = environment(); e.plugin.onLoad();
    const url = 'https://ja.aliexpress.com/item/123.html?spm=test&aff_fcid=example';
    const cleaned = 'https://ja.aliexpress.com/item/123.html';
    const short = 'https://a.aliexpress.com/_example?keep=1';
    const payload = Object.freeze({ content: `${url} ${short}`, attachments: [] });
    e.messages.sendMessage('channel', payload);
    assert.equal(e.calls.pop()[1].content, `${cleaned} ${short}`);
    assert.equal(payload.content, `${url} ${short}`);
    for (const api of [e.urls, e.commonUrls, e.native]) {
        api.openURL(url); assert.equal(e.calls.pop()[0], cleaned);
        api.openURL(short); assert.equal(e.calls.pop()[0], short);
    }
    const link = Object.freeze({ href: url, trusted: true });
    e.clicks.handleClick(link); assert.equal(e.calls.pop()[0].href, cleaned);
    assert.equal(link.href, url);
    for (const name of ['handleMessagesTapLink', 'handleMessagesTapURLLink']) {
        const event = Object.freeze({ nativeEvent: Object.freeze({ url }) });
        e.taps[name](event); assert.equal(e.calls.pop()[0].nativeEvent.url, cleaned);
        assert.equal(event.nativeEvent.url, url);
    }
    e.plugin.onUnload();
    e.urls.openURL(url); assert.equal(e.calls.pop()[0], url);
    e.plugin.onLoad();
    e.urls.openURL(url); assert.equal(e.calls.pop()[0], cleaned);
    e.plugin.onUnload();
});

function settingSwitch(e, label) {
    return e.plugin.settings().children.flatMap(child => child.children || []).find(child => child.type === 'Switch' && child.props.accessibilityLabel === label);
}


const siteCases = [
    ['cleanXLinks', 'Xのリンクを清掃', 'https://mobile.twitter.com/a?q=1', 'https://fxtwitter.com/a'],
    ['cleanAmazonLinks', 'Amazonのリンクを清掃', 'https://amazon.co.jp/dp/B012345678?tag=test', 'https://amazon.co.jp/dp/B012345678'],
    ['cleanInstagramLinks', 'Instagramのリンクを清掃', 'https://instagram.com/p/a?igsh=test', 'https://instagram.com/p/a'],
    ['cleanAliExpressLinks', 'AliExpressの商品リンクを清掃', 'https://ja.aliexpress.com/item/123.html?spm=test', 'https://ja.aliexpress.com/item/123.html']
];

test('all 16 site toggle combinations apply independently on every send/open path', () => {
    for (let mask = 0; mask < 16; mask++) {
        const storage = { replaceXWithFxTwitter: true };
        siteCases.forEach(([key], index) => { storage[key] = Boolean(mask & (1 << index)); });
        const e = environment({ storage }); e.plugin.onLoad();
        const source = siteCases.map(row => row[2]).join(' ');
        const expected = siteCases.map(([key, , url, clean]) => storage[key] ? clean : url).join(' ');
        const payload = Object.freeze({ content: source, attachments: [] });
        e.messages.sendMessage('channel', payload);
        assert.equal(e.calls.pop()[1].content, expected);
        assert.equal(payload.content, source);
        for (const [key, , url, clean] of siteCases) {
            const result = storage[key] ? clean : url;
            for (const api of [e.urls, e.commonUrls, e.native]) {
                api.openURL(url); assert.equal(e.calls.pop()[0], result);
            }
            const link = Object.freeze({ href: url });
            e.clicks.handleClick(link); assert.equal(e.calls.pop()[0].href, result);
            assert.equal(link.href, url);
            for (const name of ['handleMessagesTapLink', 'handleMessagesTapURLLink']) {
                const event = Object.freeze({ nativeEvent: Object.freeze({ url }) });
                e.taps[name](event); assert.equal(e.calls.pop()[0].nativeEvent.url, result);
                assert.equal(event.nativeEvent.url, url);
            }
        }
        e.plugin.onUnload(); assert.equal(e.hooks(), 0);
    }
});

test('each site switch defaults on, changes immediately and preserves saved values through reload', () => {
    const storage = { replaceXWithFxTwitter: true, unrelated: 'keep' };
    const e = environment({ storage }); e.plugin.onLoad();
    for (const [key, label, url, clean] of siteCases) {
        assert.equal(storage[key], true);
        assert.equal(settingSwitch(e, label).props.value, true);
        settingSwitch(e, label).props.onValueChange(false);
        assert.equal(storage[key], false);
        assert.equal(settingSwitch(e, label).props.value, false);
        e.urls.openURL(url); assert.equal(e.calls.pop()[0], url);
        settingSwitch(e, label).props.onValueChange(true);
        e.urls.openURL(url); assert.equal(e.calls.pop()[0], clean);
        settingSwitch(e, label).props.onValueChange(false);
    }
    assert.equal(storage.replaceXWithFxTwitter, true);
    e.plugin.onUnload();
    const reloaded = environment({ storage }); reloaded.plugin.onLoad();
    for (const [key, label, url] of siteCases) {
        assert.equal(storage[key], false);
        assert.equal(settingSwitch(reloaded, label).props.value, false);
        reloaded.urls.openURL(url); assert.equal(reloaded.calls.pop()[0], url);
    }
    assert.equal(storage.unrelated, 'keep');
    reloaded.plugin.onUnload();
});

test('disabling X suspends fxtwitter replacement and disables its control without losing the preference', () => {
    const storage = { replaceXWithFxTwitter: true };
    const e = environment({ storage }); e.plugin.onLoad();
    settingSwitch(e, 'Xのリンクを清掃').props.onValueChange(false);
    const fx = settingSwitch(e, 'Xをfxtwitterに置き換える');
    assert.equal(fx.props.disabled, true);
    assert.equal(fx.props.accessibilityState.disabled, true);
    fx.props.onValueChange(false);
    assert.equal(storage.replaceXWithFxTwitter, true);
    e.urls.openURL('https://x.com/a?q=1'); assert.equal(e.calls.pop()[0], 'https://x.com/a?q=1');
    settingSwitch(e, 'Xのリンクを清掃').props.onValueChange(true);
    assert.equal(settingSwitch(e, 'Xをfxtwitterに置き換える').props.disabled, false);
    e.urls.openURL('https://x.com/a?q=1'); assert.equal(e.calls.pop()[0], 'https://fxtwitter.com/a');
    e.plugin.onUnload();
});
