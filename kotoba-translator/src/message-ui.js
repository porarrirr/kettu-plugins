// Discord iOS serializes chat rows for its native view. Translate only the
// message IDs reported by that view's visible window; never change MessageStore.
function createMessageIntegration(vendetta, { getTranslator, getConfig, errorMessage, containsJapanese }) {
    const entries = new Map();
    const unpatches = [];
    const handlers = new WeakSet();
    const classes = new WeakSet();
    const instances = new Set();
    const chatHandlers = new Map();
    let enabled = false, generation = 0, window, collectTimer, redrawTimer;
    let messageStore, lastError = "", translatedCount = 0;
    const identity = message => `${message.channel_id}:${message.id}`;
    const selected = channel => vendetta.metro.common.channels?.getChannelId?.() === channel;
    let lastConfig, lastConfigKey;
    const configKey = c => {
        // getConfig supplies a new snapshot whenever saved settings change.
        if (c !== lastConfig) { lastConfig = c; lastConfigKey = JSON.stringify(c); }
        return lastConfigKey;
    };

    function redrawView(instance) {
        // iOS pushes rows imperatively; React.forceUpdate alone leaves native
        // message rows unchanged when the original MessageStore has not changed.
        if (typeof instance.updateRows === "function")
            instance.updateRows({ forceRender: true, minimizeScrolling: true });
        else instance.forceUpdate?.();
    }

    function redraw() {
        if (redrawTimer) return;
        redrawTimer = setTimeout(() => {
            redrawTimer = undefined;
            for (const instance of instances) {
                if (selected(instance.props?.channelId)) redrawView(instance);
            }
        }, 80);
    }

    function readable(text, target) {
        // Inspect the original string, including code, links and mentions.
        if (containsJapanese(text)) return false;
        const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|<[^>]*>|@everyone|@here/g, "").trim();
        if (!prose || !/[A-Za-z\u00c0-\u02ff\u0370-\u052f\u0590-\u06ff\u0900-\u0e7f\u3040-\u9fff\uac00-\ud7af]/.test(prose)) return false;
        return true;
    }

    function urlOnly(text) {
        // A link-only post renders an auto-generated preview embed; leave it untouched.
        if (typeof text !== "string") return false;
        return /https?:\/\/\S+|www\.\S+/.test(text) && !text.replace(/https?:\/\/\S+|www\.\S+|<[^>]*>/g, "").trim();
    }

    function parts(message, c) {
        if (!message || message.blocked || message.ignored || (message.type !== 0 && message.type !== 19)) return [];
        if (urlOnly(message.content)) return [];
        const result = [];
        const add = (suffix, source, path) => {
            if (typeof source === "string" && source.length <= 6000 && readable(source, c.target))
                result.push({ key: identity(message) + suffix, source, path });
        };
        add("", message.content, ["content"]);
        if (Array.isArray(message.embeds)) message.embeds.slice(0, 10).forEach((embed, index) => {
            if (typeof embed?.type === "string" && embed.type !== "rich") return;
            for (const field of ["Title", "Description"]) {
                const name = typeof embed?.[`raw${field}`] === "string" ? `raw${field}` : field.toLowerCase();
                add(`:embed:${index}:${field}`, embed?.[name], ["embeds", index, name]);
            }
            if (Array.isArray(embed?.fields)) embed.fields.slice(0, 25).forEach((field, fi) => {
                for (const name of ["Name", "Value"]) {
                    const prop = typeof field?.[`raw${name}`] === "string" ? `raw${name}` : name.toLowerCase();
                    add(`:embed:${index}:field:${fi}:${name}`, field?.[prop], ["embeds", index, "fields", fi, prop]);
                }
            });
        });
        return result;
    }

    const clone = object => Array.isArray(object) ? object.slice() : Object.assign(Object.create(Object.getPrototypeOf(object)), object);
    function replacePath(object, path, value, copies, prefix = "") {
        let copy = copies.get(prefix);
        if (!copy) { copy = clone(object); copies.set(prefix, copy); }
        const [key, ...rest] = path;
        copy[key] = rest.length ? replacePath(object[key], rest, value, copies, `${prefix}/${key}`) : value;
        return copy;
    }

    function collect() {
        collectTimer = undefined;
        const c = getConfig();
        if (!enabled || !c.autoTranslateMessages || !window || !selected(window.channel)) return;
        const group = configKey(c), epoch = generation;
        let engine;
        try { engine = getTranslator(); } catch { return; }
        engine.pruneQueue?.();
        let slots = Math.max(0, 32 - (engine.pending?.size || 0));
        let added = false;
        for (const id of window.ids.slice(0, 32)) {
            const message = messageStore.getMessage(window.channel, id);
            for (const part of parts(message, c)) {
            const key = part.key, old = entries.get(key);
            if (old && old.source === part.source && old.group === group && (old.state !== "failed" || Date.now() - old.at < 30000)) continue;
            if (slots-- <= 0) { if (added) redraw(); return; }
            const entry = { source: part.source, group, state: "pending", phase: "queued", detail: "送信待ち", at: Date.now() };
            entries.set(key, entry);
            added = true;
            // Bound memory without evicting active requests.
            if (entries.size > 150) for (const [k, value] of entries) {
                if (value.state !== "pending") { entries.delete(k); break; }
            }
            const shouldSend = () => enabled && epoch === generation && configKey(getConfig()) === group &&
                window?.channel === message.channel_id && selected(message.channel_id) && window.ids.includes(id) &&
                parts(messageStore.getMessage(message.channel_id, id), c).some(current => current.key === key && current.source === entry.source);
            engine.translate(part.source, c, (detail, event) => {
                if (!enabled || epoch !== generation || entries.get(key) !== entry) return;
                entry.phase = event?.phase || "queued"; entry.detail = detail;
                if (entry.phase === "sending") entry.sent = (entry.sent || 0) + 1;
                redraw();
            }, { shouldSend }).then(result => {
                if (!enabled || epoch !== generation || entries.get(key) !== entry || configKey(getConfig()) !== group) return;
                entry.result = result; entry.state = "ready";
                translatedCount++; lastError = "";
                redraw();
                clearTimeout(collectTimer); collectTimer = setTimeout(collect, 200);
            }).catch(error => {
                if (!enabled || epoch !== generation || entries.get(key) !== entry) return;
                if (error.code === "TRANSLATION_NOT_VISIBLE") { entries.delete(key); return; }
                entry.state = "failed"; entry.at = Date.now();
                entry.error = errorMessage(error); lastError = entry.error; redraw();
            });
            }
        }
        if (added) redraw();
    }

    function visible(event) {
        if (!enabled || !event || !Array.isArray(event.rows)) return;
        const first = event.firstVisibleMessageRowIndex, last = event.lastVisibleMessageRowIndex;
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < 0) {
            window = undefined; try { getTranslator().pruneQueue?.(); } catch {} return;
        }
        const rows = event.rows.slice(Math.min(first, last), Math.max(first, last) + 1);
        const messages = rows.map(row => row.message).filter(message => message && typeof message.id === "string" && typeof message.channelId === "string");
        if (!messages.length) { window = undefined; try { getTranslator().pruneQueue?.(); } catch {} return; }
        const channel = messages[0].channelId;
        window = { channel, ids: messages.filter(message => message.channelId === channel).map(message => message.id) };
        try { getTranslator().pruneQueue?.(); } catch {}
        clearTimeout(collectTimer);
        collectTimer = setTimeout(collect, 200);
    }

    function watchChat(args) {
        const [type, props] = args;
        const handler = props?.visibleMessagesWindowHandler;
        if (!handler || typeof handler.handleScrollPosition !== "function") return;
        chatHandlers.set(handler, props.channelId || props.channel?.id);
        if (!handlers.has(handler)) {
            handlers.add(handler);
            unpatches.push(vendetta.patcher.after("handleScrollPosition", handler, args => visible(args[0])));
        }
        const proto = type?.prototype;
        if (proto && typeof proto.render === "function" && !classes.has(proto)) {
            classes.add(proto);
            unpatches.push(vendetta.patcher.before("render", proto, function () { instances.add(this); }));
            if (typeof proto.componentWillUnmount === "function")
                unpatches.push(vendetta.patcher.before("componentWillUnmount", proto, function () { instances.delete(this); }));
        }
    }

    function status() {
        const c = getConfig();
        const current = window && selected(window.channel) ? window : null;
        const group = configKey(c);
        const targets = (current?.ids || []).flatMap(id => parts(messageStore.getMessage(current.channel, id), c));
        const visibleEntries = targets.map(part => {
            const entry = entries.get(part.key);
            return entry?.group === group && entry.source === part.source ? entry : null;
        }).filter(Boolean);
        const pending = visibleEntries.filter(entry => entry.state === "pending");
        const failed = visibleEntries.filter(entry => entry.state === "failed");
        const ready = visibleEntries.filter(entry => entry.state === "ready");
        const unsent = targets.length - visibleEntries.length;
        const sending = pending.filter(entry => entry.phase === "sending");
        const waiting = pending.filter(entry => entry.phase === "waiting");
        let activity = { sent: 0, active: 0, lastSentAt: null };
        try { activity = getTranslator().getActivity?.() || activity; } catch { /* Stopped. */ }
        const label = !enabled ? "自動翻訳を利用できません" : !c.autoTranslateMessages ? "自動翻訳 OFF" : !current ? "表示範囲を待っています（未送信）" :
            sending.length ? `翻訳リクエスト送信中 · ${sending.length} 件` : waiting.length ? `API 制限・切替待ち · ${waiting.length} 件` :
            pending.length ? `リクエスト待ち · ${pending.length} 件` : failed.length ? `翻訳エラー · ${failed.length} 件` : unsent ? `未送信 · ${unsent} 箇所` : ready.length ? `翻訳完了 · ${ready.length} 箇所` : "翻訳対象なし（未送信）";
        return { available: enabled, translated: translatedCount, visible: current?.ids.length || 0, pending: pending.length, views: instances.size,
            label, error: failed[0]?.error || (!current ? lastError : ""), detail: sending[0]?.detail || waiting[0]?.detail || pending[0]?.detail || "",
            completed: ready.length, failed: failed.length, ...activity };
    }

    function retryVisible() {
        const c = getConfig();
        if (!enabled || !c.autoTranslateMessages) return { accepted: false, message: "自動翻訳を ON にしてください。" };
        if (!window || !selected(window.channel)) {
            for (const [handler, channel] of chatHandlers) if (selected(channel) && handler.data) visible(handler.data);
        }
        if (!window || !selected(window.channel)) {
            redraw();
            return { accepted: false, message: "表示範囲を再取得しています。少しスクロールしてから更新してください。" };
        }
        if (status().pending) return { accepted: false, message: "翻訳リクエストを処理中です。重複送信はしません。" };
        try { for (const id of window.ids) for (const part of parts(messageStore.getMessage(window.channel, id), c)) {
            const engine = getTranslator();
            if (engine.forget) engine.forget(part.source, c); else engine.clearCache();
        } } catch (error) { return { accepted: false, message: errorMessage(error) }; }
        for (const id of window.ids) for (const part of parts(messageStore.getMessage(window.channel, id), c)) entries.delete(part.key);
        lastError = "";
        clearTimeout(collectTimer);
        collect();
        const current = status();
        return { accepted: current.pending > 0, message: current.pending ? "表示中のメッセージを翻訳待ちに追加しました。" : current.label };
    }

    const retryLinks = new Map();
    const retryToken = Math.random().toString(36).slice(2);
    let canRetryLinks = false;
    function messageStatus(message) {
        const c = getConfig(), group = configKey(c), targets = parts(message, c);
        const values = targets.map(part => {
            const entry = entries.get(part.key);
            return entry?.source === part.source && entry.group === group ? entry : null;
        });
        const pending = values.filter(entry => entry?.state === "pending");
        const failed = values.filter(entry => entry?.state === "failed");
        const ready = values.filter(entry => entry?.state === "ready");
        const sent = values.reduce((total, entry) => total + (entry?.sent || 0), 0);
        const cached = ready.some(entry => entry.phase === "cached");
        const phase = pending.some(entry => entry.phase === "sending") ? "翻訳中" : pending.some(entry => entry.phase === "waiting") ? "API 制限・切替待ち" : pending.length ? "送信待ち" : failed.length ? "翻訳エラー" : ready.length === targets.length ? "翻訳済み" : "未送信";
        return { eligible: targets.length > 0, pending: pending.length, label: `${phase}${cached ? " · キャッシュ" : ready.length && !sent ? " · 共有結果" : ` · 送信 ${sent} 回`}${targets.length > 1 ? ` · ${ready.length}/${targets.length} 箇所` : ""}`, error: failed[0]?.error || "" };
    }
    function retryMessage(channel, id) {
        if (!enabled || !getConfig().autoTranslateMessages || window?.channel !== channel || !selected(channel) || !window.ids.includes(id))
            return { accepted: false, message: "現在表示中のメッセージだけ再翻訳できます。" };
        const message = messageStore.getMessage(channel, id);
        if (messageStatus(message).pending) return { accepted: false, message: "翻訳リクエストを処理中です。" };
        const c = getConfig(), engine = getTranslator();
        for (const part of parts(message, c)) {
            engine.forget?.(part.source, c);
            entries.delete(part.key);
        }
        clearTimeout(collectTimer); collect(); redraw();
        return { accepted: messageStatus(message).pending > 0 };
    }
    function findRetryLink(value, depth = 0) {
        if (typeof value === "string") return retryLinks.has(value) ? value : undefined;
        if (!value || typeof value !== "object" || depth > 3) return;
        for (const key of ["url", "href", "target", "nativeEvent", "link"]) {
            const found = findRetryLink(value[key], depth + 1);
            if (found) return found;
        }
    }

    return {
        install() {
            if (enabled) return true;
            try {
                const renderer = vendetta.metro.findByName?.("createMessageContent", false);
                const runtime = vendetta.metro.findByProps?.("jsx", "jsxs", "Fragment");
                messageStore = vendetta.metro.findByStoreName?.("MessageStore");
                if (!renderer?.default || !runtime || !messageStore?.getMessage || !vendetta.patcher?.after) return false;
                enabled = true;
                unpatches.push(vendetta.patcher.before("default", renderer, args => {
                    const props = args[0], message = props?.message, c = getConfig();
                    if (!enabled || !c.autoTranslateMessages || !message || props.isEditing) return;
                    let copy = message, embedChanged = false;
                    const group = configKey(c), copies = new Map();
                    for (const part of parts(message, c)) {
                        const entry = entries.get(part.key);
                        if (entry?.state !== "ready" || entry.source !== part.source || entry.group !== group) continue;
                        copy = replacePath(message, part.path, entry.result, copies);
                        if (part.path[0] === "embeds") embedChanged = true;
                    }
                    if (copy !== message) args[0] = { ...props, message: copy, ...(embedChanged ? { options: { ...props.options, ignoreEmbedDescriptionCache: true } } : {}) };
                }));
                const links = vendetta.metro.findByProps?.("handleMessagesTapURLLink", "handleMessagesTapLink");
                if (links && vendetta.patcher.instead) {
                    for (const name of ["handleMessagesTapURLLink", "handleMessagesTapLink"]) if (typeof links[name] === "function") {
                        unpatches.push(vendetta.patcher.instead(name, links, (args, original) => {
                            const url = args.map(value => findRetryLink(value)).find(Boolean);
                            if (!url) return original(...args);
                            const target = retryLinks.get(url);
                            retryMessage(target.channel, target.id);
                        }));
                        canRetryLinks = true;
                    }
                }
                unpatches.push(vendetta.patcher.after("default", renderer, (args, result) => {
                    const props = args[0], m = props?.message;
                    if (!enabled || !getConfig().autoTranslateMessages || props.isEditing || props.renderContentOnly || result?.renderContentOnly || !m || !result || (result.content != null && !Array.isArray(result.content))) return;
                    const original = messageStore.getMessage(m.channel_id, m.id);
                    if (!original) return;
                    const value = messageStatus(original);
                    if (!value.eligible) return;
                    const url = `https://kettu-translator.invalid/${retryToken}/${m.channel_id}/${m.id}`;
                    if (canRetryLinks) {
                        retryLinks.set(url, { channel: m.channel_id, id: m.id });
                        if (retryLinks.size > 200) retryLinks.delete(retryLinks.keys().next().value);
                    }
                    const stats = [{ type: "text", content: `${value.label}${value.error ? ` · ${value.error}` : ""}` }];
                    if (canRetryLinks && !value.pending) stats.push({ type: "text", content: " · " }, { type: "link", target: url, title: "再翻訳", content: [{ type: "text", content: "↻ 再翻訳" }] });
                    const content = [...(result.content || []), { type: "text", content: "\n" }, { type: "subtext", content: stats }];
                    return { ...result, content };
                }));
                for (const name of ["jsx", "jsxs"]) if (typeof runtime[name] === "function") {
                    unpatches.push(vendetta.patcher.before(name, runtime, watchChat));
                }
                return true;
            } catch { this.dispose(); return false; }
        },
        refresh() {
            generation++; entries.clear(); lastError = ""; translatedCount = 0;
            clearTimeout(collectTimer);
            redraw();
            if (enabled) collectTimer = setTimeout(collect, 200);
        },
        status, retryVisible, retryMessage, messageStatus,
        dispose() {
            enabled = false; generation++; entries.clear();
            clearTimeout(collectTimer); clearTimeout(redrawTimer); redrawTimer = undefined;
            for (const unpatch of unpatches.splice(0).reverse()) unpatch();
            for (const instance of instances) redrawView(instance);
            instances.clear(); chatHandlers.clear(); retryLinks.clear(); window = undefined;
        },
    };
}
