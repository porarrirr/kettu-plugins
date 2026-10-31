const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
function setup(ui = false, compiled = false) {
  let config = { autoTranslateMessages: true, target: "JA" }, selected = "chat", counter = 0;
  const timers = /* @__PURE__ */ new Map(), records = /* @__PURE__ */ new Map(), calls = [];
  const source = compiled ? fs.readFileSync(path.join(__dirname, "../index.js"), "utf8").replace("return createPlugin(vendetta,module.exports);", "return createMessageIntegration;") : fs.readFileSync(path.join(__dirname, "../src/message-ui.js"), "utf8") + "\ncreateMessageIntegration;";
  const create = vm.runInNewContext(source, {
    setTimeout(fn) {
      const id = ++counter;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });
  const renderer = { default: (props) => ui ? { ...props.message, content: props.message.content ? [{ type: "text", content: props.message.content }] : undefined } : props.message };
  const opened = [];
  const links = { handleMessagesTapURLLink: (...args) => opened.push(args), handleMessagesTapLink: (...args) => opened.push(args) };
  const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const patcher = { instead(name, obj, fn) { const old = obj[name]; obj[name] = function(...args) { return fn(args, old.bind(this)); }; return () => { obj[name] = old; }; }, before(name, obj, fn) {
    const old = obj[name];
    obj[name] = function(...args) {
      fn.call(this, args);
      return old.apply(this, args);
    };
    return () => {
      obj[name] = old;
    };
  }, after(name, obj, fn) {
    const old = obj[name];
    obj[name] = function(...args) {
      const result = old.apply(this, args);
      return fn.call(this, args, result) ?? result;
    };
    return () => {
      obj[name] = old;
    };
  } };
  const vendetta = { metro: { common: { channels: { getChannelId: () => selected } }, findByName: () => renderer, findByProps: (...props) => props.includes("handleMessagesTapURLLink") ? links : runtime, findByStoreName: () => ({ getMessage: (channel, id) => channel === "chat" ? records.get(id) : void 0 }) }, patcher };
  const activity = { sent: 0, active: 0, lastSentAt: null };
  let cacheClears = 0;
  if (ui) {
    vendetta.metro.common.React = {createElement: (type, props, ...children) => ({type, props, children}), useState: value => [typeof value === "function" ? value() : value, () => {}], useEffect() {}};
    vendetta.metro.common.ReactNative = {View: "View", Text: "Text", Pressable: "Pressable", useColorScheme: () => "light"};
  }
  const integration = create(vendetta, { containsJapanese: require('../src/core.cjs').containsJapanese, getConfig: () => config, getTranslator: () => ({ clearCache() { cacheClears++; }, getActivity() { return {...activity}; }, translate(text, c, report, options) {
    return new Promise((resolve, reject) => calls.push({ text, config: c, resolve, reject, report, options }));
  } }), errorMessage: () => "safe error" });
  class Messages {
    constructor() {
      this.props = { channelId: "chat" };
      this.nativeUpdates = 0;
    }
    render() {
      this.rendered = [...records.values()].map((message) => renderer.default({ message }));
    }
    forceUpdate() {
    }
    updateRows(options) {
      assert.equal(options.forceRender, true);
      assert.equal(options.minimizeScrolling, true);
      this.nativeUpdates++;
      this.render();
    }
    componentWillUnmount() {
    }
  }
  const handler = { handleScrollPosition(event) {
    return event;
  } };
  function add(id, content, extra = {}) {
    const m = Object.freeze(Object.assign(/* @__PURE__ */ Object.create({ label() {
      return this.content;
    } }), { id, channel_id: "chat", type: 0, content, attachments: [] }, extra));
    records.set(id, m);
    return m;
  }
  function mount() {
    runtime.jsx(Messages, { visibleMessagesWindowHandler: handler });
    const instance = new Messages();
    instance.render();
    return instance;
  }
  function show(ids, first = 0, last = ids.length - 1) {
    handler.handleScrollPosition({ rows: ids.map((id) => ({ message: { id, channelId: "chat" } })), firstVisibleMessageRowIndex: first, lastVisibleMessageRowIndex: last });
  }
  function tick() {
    const work = [...timers.values()];
    timers.clear();
    work.forEach((fn) => fn());
  }
  return { integration, renderer, runtime, Messages, handler, activity, links, opened, cacheClears: () => cacheClears, add, mount, show, tick, calls, timers, set: (c) => {
    config = { ...config, ...c };
  }, select: (c) => {
    selected = c;
  } };
}
const nativeText = nodes => nodes.map(node => typeof node.content === "string" ? node.content : nativeText(node.content || [])).join("");
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test("native viewport bounds alone trigger translation and replace copies while preserving original records", async () => {
  const e = setup();
  e.integration.install();
  const a = e.add("a", "Outside"), b = e.add("b", "Hello");
  e.add("c", "Good evening");
  e.add("d", "Outside too");
  const view = e.mount();
  e.tick();
  assert.equal(e.calls.length, 0);
  e.show(["a", "b", "c", "d"], 2, 1);
  e.tick();
  assert.deepEqual(e.calls.map((c) => c.text), ["Hello", "Good evening"]);
  e.calls[0].resolve("\u3053\u3093\u306B\u3061\u306F");
  e.calls[1].resolve("\u3053\u3093\u3070\u3093\u306F");
  await settle();
  e.tick();
  assert.ok(view.nativeUpdates > 0);
  assert.equal(view.rendered[1].content, "\u3053\u3093\u306B\u3061\u306F");
  assert.equal(view.rendered[1].label(), "\u3053\u3093\u306B\u3061\u306F");
  assert.equal(view.rendered[1].attachments, b.attachments);
  assert.equal(b.content, "Hello");
  assert.equal(view.rendered[0], a);
  e.show(["b", "c"]);
  e.tick();
  assert.equal(e.calls.length, 2);
  e.integration.dispose();
  assert.equal(view.rendered[1], b);
});
test("scroll debounce and channel switching prevent requests for messages outside the active window", () => {
  const e = setup();
  e.integration.install();
  e.add("a", "First");
  e.add("b", "Second");
  e.mount();
  e.show(["a"]);
  e.show(["b"]);
  e.tick();
  assert.deepEqual(e.calls.map((c) => c.text), ["Second"]);
  e.show(["a"]);
  e.select("elsewhere");
  e.tick();
  assert.equal(e.calls.length, 1);
  e.integration.dispose();
});
test("disable/settings refresh/unload restore originals and discard late translations", async () => {
  const e = setup();
  e.integration.install();
  const original = e.add("a", "Hello"), view = e.mount();
  e.show(["a"]);
  e.tick();
  e.set({ autoTranslateMessages: false });
  e.integration.refresh();
  e.calls[0].resolve("late");
  await settle();
  e.tick();
  assert.equal(view.rendered[0], original);
  e.set({ autoTranslateMessages: true, target: "FR" });
  e.integration.refresh();
  e.tick();
  assert.equal(e.calls[1].config.target, "FR");
  e.calls[1].resolve("Bonjour");
  await settle();
  e.tick();
  assert.equal(view.rendered[0].content, "Bonjour");
  e.set({ target: "JA" });
  e.integration.refresh();
  e.tick();
  assert.equal(view.rendered[0], original);
  e.integration.dispose();
  e.calls[2].resolve("late again");
  await settle();
  assert.equal(e.timers.size, 0);
});
test("message edits invalidate translations and editing always shows original content", async () => {
  const e = setup();
  e.integration.install();
  e.add("a", "Hello");
  e.mount();
  e.show(["a"]);
  e.tick();
  e.calls[0].resolve("\u3053\u3093\u306B\u3061\u306F");
  await settle();
  e.tick();
  const edited = e.add("a", "Changed");
  assert.equal(e.renderer.default({ message: edited }), edited);
  e.show(["a"]);
  e.tick();
  e.calls[1].resolve("\u5909\u66F4");
  await settle();
  e.tick();
  assert.equal(e.renderer.default({ message: edited, isEditing: true }), edited);
  assert.equal(e.renderer.default({ message: edited }).content, "\u5909\u66F4");
  e.integration.dispose();
});
test("skip blocked/system/code/link/Japanese messages; failure retains original with sanitized status", async () => {
  const e = setup();
  e.integration.install();
  e.add("blocked", "Hidden", { blocked: true });
  e.add("system", "System", { type: 7 });
  e.add("link", "https://example.com");
  e.add("code", "```const x = 1;```");
  e.add("ja", "\u3053\u3093\u306B\u3061\u306F");
  const original = e.add("en", "Hello there"), view = e.mount();
  e.show(["blocked", "system", "link", "code", "ja", "en"]);
  e.tick();
  assert.deepEqual(e.calls.map((c) => c.text), ["Hello there"]);
  e.calls[0].reject(new Error("secret"));
  await settle();
  e.tick();
  assert.equal(view.rendered.at(-1), original);
  assert.equal(e.integration.status().error, "safe error");
  e.show(["en"]);
  e.tick();
  assert.equal(e.calls.length, 1);
  e.integration.dispose();
});

test("link-only posts skip their auto-generated preview embeds while mixed text still translates", async () => {
  const e = setup(false, true); e.integration.install();
  const link = e.add("link", "https://example.com", { embeds: [{ url: "https://example.com", rawTitle: "Example Domain", rawDescription: "This domain is for use in illustrative examples" }] });
  const www = e.add("www", "www.example.com", { embeds: [{ url: "https://example.com", rawTitle: "Example", rawDescription: "Preview text" }] });
  const mixed = e.add("mixed", "See https://example.com for details", { embeds: [{ url: "https://example.com", rawTitle: "Example Domain", rawDescription: "Preview text" }] });
  const view = e.mount(); e.show(["link", "www", "mixed"]); e.tick();
  assert.deepEqual(e.calls.map(c => c.text), ["See https://example.com for details", "Example Domain", "Preview text"]);
  assert.equal(e.integration.messageStatus(link).eligible, false);
  assert.equal(e.integration.messageStatus(www).eligible, false);
  e.calls.forEach(call => call.resolve("訳")); await settle(); e.tick();
  assert.equal(view.rendered[0], link);
  assert.equal(link.embeds[0].rawTitle, "Example Domain");
  assert.equal(view.rendered[2].content, "訳");
  assert.equal(view.rendered[2].embeds[0].rawTitle, "訳");
  e.integration.dispose();
});

test("auto link previews and mention-only pings stay original while authored embeds translate", async () => {
  const e = setup(false, true); e.integration.install();
  const preview = e.add("preview", "Check this out", { embeds: [{ type: "link", url: "https://example.com", rawTitle: "Preview title", rawDescription: "Preview text" }] });
  const rich = e.add("rich", "Bot says", { embeds: [{ type: "rich", rawTitle: "Authored title" }] });
  const untyped = e.add("untyped", "Legacy embed", { embeds: [{ rawTitle: "Untyped title" }] });
  const ping = e.add("ping", "@everyone");
  const pingText = e.add("pingText", "Hello @everyone");
  const view = e.mount(); e.show(["preview", "rich", "untyped", "ping", "pingText"]); e.tick();
  assert.deepEqual(e.calls.map(c => c.text), ["Check this out", "Bot says", "Authored title", "Legacy embed", "Untyped title", "Hello @everyone"]);
  assert.equal(e.integration.messageStatus(ping).eligible, false);
  assert.equal(e.integration.messageStatus(preview).eligible, true);
  e.calls.forEach(call => call.resolve("訳")); await settle(); e.tick();
  assert.equal(view.rendered[0].content, "訳");
  assert.equal(view.rendered[0].embeds[0].rawTitle, "Preview title");
  assert.equal(view.rendered[1].embeds[0].rawTitle, "訳");
  assert.equal(view.rendered[2].embeds[0].rawTitle, "訳");
  assert.equal(view.rendered[3], ping);
  e.integration.dispose();
});

test('automatic status separates unsent queue, API wait, active send, completion and visible failures', async () => {
  const e = setup(); e.integration.install(); e.add('a', 'Hello'); e.add('b', 'Second'); e.mount();
  assert.match(e.integration.status().label, /未送信/);
  e.show(['a', 'b']); e.tick();
  assert.match(e.integration.status().label, /リクエスト待ち/);
  assert.equal(e.integration.status().sent, 0);
  e.calls[0].report('gemini sending', { phase: 'sending' });
  Object.assign(e.activity, { sent: 1, active: 1, lastSentAt: 100 });
  assert.match(e.integration.status().label, /送信中/);
  assert.equal(e.integration.status().active, 1);
  e.calls[0].report('rate limit wait', { phase: 'waiting' }); e.activity.active = 0;
  assert.match(e.integration.status().label, /API 制限/);
  e.calls[0].reject(new Error('failure')); e.calls[1].resolve('訳'); await settle();
  assert.match(e.integration.status().label, /翻訳エラー/);
  assert.equal(e.integration.status().error, 'safe error');
  assert.equal(e.integration.status().completed, 1);
  e.integration.dispose();
});

test('manual update bypasses failed cooldown and completed cache, without duplicating pending jobs', async () => {
  const e = setup(); e.integration.install(); e.add('a', 'Hello'); e.mount(); e.show(['a']);
  assert.equal(e.integration.retryVisible().accepted, true); assert.equal(e.calls.length, 1);
  assert.equal(e.integration.retryVisible().accepted, false); assert.equal(e.calls.length, 1);
  e.calls[0].reject(new Error('failure')); await settle();
  assert.equal(e.integration.retryVisible().accepted, true); assert.equal(e.calls.length, 2);
  e.calls[1].resolve('訳'); await settle(); e.tick();
  assert.match(e.integration.status().label, /翻訳完了/);
  assert.equal(e.integration.retryVisible().accepted, true); assert.equal(e.calls.length, 3);
  assert.equal(e.cacheClears(), 3); e.integration.dispose();
});

test('manual update recovers cached native viewport; never sends the previous channel or entire history', () => {
  const e = setup(); e.integration.install(); e.add('a', 'Hello'); e.add('b', 'Outside'); e.mount();
  assert.equal(e.integration.retryVisible().accepted, false); assert.equal(e.calls.length, 0);
  e.handler.data = { rows: [{ message: { id: 'a', channelId: 'chat' } }], firstVisibleMessageRowIndex: 0, lastVisibleMessageRowIndex: 0 };
  // The observed props identify which channel owns the native handler.
  e.runtime.jsx(e.Messages, { visibleMessagesWindowHandler: e.handler, channelId: 'chat' });
  assert.equal(e.integration.retryVisible().accepted, true); assert.equal(e.calls.length, 1);
  e.select('elsewhere'); assert.equal(e.integration.retryVisible().accepted, false); assert.equal(e.calls.length, 1);
  e.integration.dispose();
});

test('native message stats replace the top panel and retry only their own visible message', async () => {
  const e = setup(true, true); e.integration.install(); const a=e.add('a','Hello'), b=e.add('b','Second'); e.mount(); e.show(['a','b']);
  assert.equal(e.runtime.jsx(e.Messages,{visibleMessagesWindowHandler:e.handler,channelId:'chat'}).type,e.Messages);
  const text = m => nativeText(e.renderer.default({message:m}).content);
  assert.equal(e.renderer.default({message:a}).content.at(-1).type,'subtext');
  assert.match(text(a),/未送信/);
  e.tick(); e.calls[0].report('sending',{phase:'sending'});
  assert.match(text(a),/翻訳中 · 送信 1 回/); assert.match(text(b),/送信待ち/);
  e.calls[0].resolve('こんにちは'); e.calls[1].reject(new Error('secret')); await settle(); e.tick();
  assert.match(text(a),/翻訳済み/); assert.match(text(b),/翻訳エラー.*safe error/);
  const link=e.renderer.default({message:a}).content.at(-1).content.find(n=>n.type==='link');
  e.links.handleMessagesTapURLLink({nativeEvent:{url:link.target}});
  assert.deepEqual(e.calls.map(c=>c.text),['Hello','Second','Hello']);
  e.links.handleMessagesTapURLLink({url:link.target}); assert.equal(e.calls.length,3);
  e.links.handleMessagesTapURLLink({url:'https://example.com'}); assert.equal(e.opened.length,1);
  e.show(['b']); e.links.handleMessagesTapLink({url:link.target}); assert.equal(e.calls.length,3);
  assert.equal(a.content,'Hello'); assert.equal(b.content,'Second'); e.integration.dispose();
});

test('stats cover embed-only messages and cached results, but stay out of editing and reply previews', async () => {
  const e=setup(true);e.integration.install();const a=e.add('a','',{embeds:[{rawDescription:'Description'}]});e.mount();e.show(['a']);e.tick();
  assert.match(nativeText(e.renderer.default({message:a}).content),/送信待ち/);
  e.calls[0].report('cache',{phase:'cached'});e.calls[0].resolve('説明');await settle();e.tick();
  assert.match(nativeText(e.renderer.default({message:a}).content),/翻訳済み · キャッシュ/);
  assert.equal(e.renderer.default({message:a,isEditing:true}).content,undefined);
  assert.equal(e.renderer.default({message:a,renderContentOnly:true}).content,undefined);
  e.set({autoTranslateMessages:false});assert.equal(e.renderer.default({message:a}).content,undefined);e.integration.dispose();
});

test('compiled distribution binds each asynchronous translation to its own message, even out of order', async () => {
  const e = setup(false, true); e.integration.install();
  e.add('a', 'First message'); e.add('b', 'Second message'); e.add('c', 'Third message'); const view = e.mount();
  e.show(['a', 'b', 'c']); e.tick();
  e.calls[2].resolve('三番目'); e.calls[0].resolve('一番目'); e.calls[1].resolve('二番目'); await settle(); e.tick();
  assert.deepEqual(view.rendered.map(m => m.content), ['一番目', '二番目', '三番目']);
  assert.equal(e.integration.status().completed, 3); assert.equal(e.integration.status().pending, 0);
  e.integration.dispose();
});

test('visible embed text is translated without altering image, URL or original records', async () => {
  const e = setup(false, true); e.integration.install();
  const image = Object.freeze({ url: 'https://example.com/image.png' });
  const original = e.add('a', 'Message text', { embeds: Object.freeze([Object.freeze({ id: 'embed', url: 'https://example.com', image,
    rawTitle: 'Title here', rawDescription: 'Description here', fields: Object.freeze([Object.freeze({ rawName: 'Field name', rawValue: 'Field value' })]) })]) });
  const view = e.mount(); e.show(['a']); e.tick();
  assert.deepEqual(e.calls.map(c => c.text), ['Message text', 'Title here', 'Description here', 'Field name', 'Field value']);
  e.calls.slice().reverse().forEach(call => call.resolve(`訳:${call.text}`)); await settle(); e.tick();
  const displayed = view.rendered[0];
  assert.equal(displayed.content, '訳:Message text'); assert.equal(displayed.embeds[0].rawTitle, '訳:Title here');
  assert.equal(displayed.embeds[0].rawDescription, '訳:Description here'); assert.equal(displayed.embeds[0].fields[0].rawValue, '訳:Field value');
  assert.equal(displayed.embeds[0].image, image); assert.equal(displayed.embeds[0].url, 'https://example.com');
  assert.equal(original.embeds[0].rawDescription, 'Description here'); assert.equal(original.embeds[0].fields[0].rawValue, 'Field value');
  e.integration.dispose();
});

test('send-time relevance follows the latest viewport, edits and selected channel, not the enqueue-time snapshot', () => {
  const e = setup(false, true); e.integration.install(); e.add('a', 'First'); e.add('b', 'Second'); e.mount();
  e.show(['a']); e.tick(); const a = e.calls[0].options.shouldSend; assert.equal(a(), true);
  e.show(['b']); e.tick(); const b = e.calls[1].options.shouldSend; assert.equal(a(), false); assert.equal(b(), true);
  e.add('b', 'Edited'); assert.equal(b(), false);
  e.select('other'); assert.equal(a(), false); e.integration.dispose();
});

test('unchanged viewport notifications do not force native redraws while pending or after completion', async () => {
  const e = setup(false, true); e.integration.install(); e.add('a', 'Hello');
  const view = e.mount(); e.show(['a']); e.tick(); e.tick();
  const pendingUpdates = view.nativeUpdates;
  for (let i = 0; i < 100; i++) { e.show(['a']); e.tick(); e.tick(); }
  assert.equal(view.nativeUpdates, pendingUpdates); assert.equal(e.calls.length, 1);
  e.calls[0].resolve('こんにちは'); await settle(); e.tick(); e.tick();
  const completedUpdates = view.nativeUpdates;
  assert.ok(completedUpdates > pendingUpdates);
  for (let i = 0; i < 100; i++) { e.show(['a']); e.tick(); e.tick(); }
  assert.equal(view.nativeUpdates, completedUpdates); assert.equal(e.calls.length, 1);
  assert.equal(view.rendered[0].content, 'こんにちは'); e.integration.dispose();
});

test('embed replacement clones each branch once while preserving every translated field', async () => {
  const e = setup(false, true); e.integration.install();
  let copies = 0;
  const image = { url: 'https://example.com/image' };
  const embed = { rawTitle: 'Title', rawDescription: 'Description', fields: [{ rawName: 'Name', rawValue: 'Value' }],
    get image() { copies++; return image; } };
  const original = e.add('a', 'Hello', { embeds: [embed] });
  e.mount(); e.show(['a']); e.tick();
  e.calls.forEach(call => call.resolve(`訳:${call.text}`)); await settle();
  copies = 0;
  const displayed = e.renderer.default({ message: original });
  assert.equal(copies, 1);
  assert.equal(displayed.content, '訳:Hello');
  assert.equal(displayed.embeds[0].rawTitle, '訳:Title');
  assert.equal(displayed.embeds[0].rawDescription, '訳:Description');
  assert.equal(displayed.embeds[0].fields[0].rawName, '訳:Name');
  assert.equal(displayed.embeds[0].fields[0].rawValue, '訳:Value');
  assert.equal(displayed.embeds[0].image, image);
  assert.equal(embed.rawTitle, 'Title'); assert.equal(embed.fields[0].rawName, 'Name');
  e.integration.dispose();
});

test('row renders reuse configuration serialization and invalidate it after settings change', () => {
  const e = setup(true, true); e.integration.install(); const original = e.add('a', 'Hello'); e.mount();
  let serializations = 0;
  e.set({ toJSON() { serializations++; return { target: this.target, autoTranslateMessages: this.autoTranslateMessages }; } });
  for (let i = 0; i < 100; i++) e.renderer.default({ message: original });
  assert.equal(serializations, 1);
  e.set({ target: 'FR' }); e.renderer.default({ message: original });
  assert.equal(serializations, 2); e.integration.dispose();
});

test('compiled auto translation skips a single Japanese character in mixed text, code, links and embeds', () => {
  for (const target of ['JA', 'EN-US']) {
    const e = setup(true, true); e.set({ target }); e.integration.install();
    const texts = ['Hello あ', 'Hello ア', 'Hello ｱ', 'Hello 漢', 'Hello 𠮷', 'Hello `あ`', 'Hello https://example.com/日'];
    texts.forEach((text, i) => e.add(String(i), text));
    const embed = e.add('embed', '', { embeds: [{ rawTitle: 'Hello あ', rawDescription: 'English description', fields: [{ rawName: '日本語 Name', rawValue: 'English value' }] }] });
    e.mount(); e.show([...texts.map((_, i) => String(i)), 'embed']); e.tick();
    assert.deepEqual(e.calls.map(call => call.text), ['English description', 'English value']);
    texts.forEach((text, i) => assert.equal(e.integration.messageStatus({ id: String(i), channel_id: 'chat', type: 0, content: text }).eligible, false));
    assert.equal(embed.embeds[0].rawTitle, 'Hello あ');
    e.integration.dispose();
  }
});

test('editing a queued English message to include Japanese prevents send-time dispatch', () => {
  const e = setup(false, true); e.integration.install(); e.add('a', 'Hello'); e.mount(); e.show(['a']); e.tick();
  assert.equal(e.calls[0].options.shouldSend(), true);
  e.add('a', 'Hello あ'); assert.equal(e.calls[0].options.shouldSend(), false);
  e.show(['a']); e.tick(); assert.equal(e.calls.length, 1); e.integration.dispose();
});
