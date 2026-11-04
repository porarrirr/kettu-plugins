(function(){var module={exports:{}};
// ES5 syntax intentionally: this also runs inside the iOS expression evaluator.
function cleanUrl(value, replaceX) {
    if (typeof value !== "string") return value;
    // Exact host check avoids touching lookalike domains or credentials.
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|x\.com|twitter\.com|amazon\.(?:com(?:\.(?:au|br|mx|be|tr))?|co\.(?:jp|uk|za)|de|fr|it|es|ca|in|nl|se|pl|ie|ae|sa|sg|eg|cn)|amzn\.(?:asia|to))(?=[:/?#]|$)(?::\d+)?(?:[/?#]|$)/i.test(value)) return value;
    var query = value.indexOf("?");
    var fragment = value.indexOf("#");
    var cleaned = query < 0 || (fragment >= 0 && fragment < query) ? value : value.slice(0, query);
    if (replaceX === true) {
        cleaned = cleaned.replace(/^(https?:\/\/)(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com)(?=[:/?#]|$)/i, "$1fxtwitter.com");
    }
    return cleaned;
}
function cleanText(value, replaceX) {
    if (typeof value !== "string") return value;
    return value.replace(/https?:\/\/[^\s<>"'`\u3000\u3001\u3002\uff01\uff1f\uff09\u300d\u300f]+/gi, function (token) {
        // Keep surrounding Markdown and sentence punctuation out of the URL.
        var suffix = "";
        while (/[)\]},.!;:]$/.test(token)) {
            suffix = token.slice(-1) + suffix;
            token = token.slice(0, -1);
        }
        return cleanUrl(token, replaceX) + suffix;
    });
}
function copyField(object, key, transform) {
    if (!object || typeof object !== "object" || typeof object[key] !== "string") return object;
    var cleaned = transform(object[key]);
    if (cleaned === object[key]) return object;
    var descriptors = Object.getOwnPropertyDescriptors(object);
    var descriptor = descriptors[key];
    // Accessors cannot be combined with value/writable. Inherited properties
    // have no own descriptor, so materialize the cleaned value on the copy.
    descriptors[key] = {
        value: cleaned,
        enumerable: descriptor ? descriptor.enumerable : true,
        configurable: descriptor ? descriptor.configurable : true,
        writable: descriptor && "value" in descriptor ? descriptor.writable : true
    };
    // Preserve prototypes, nonenumerable properties, and attachments.
    return Object.create(Object.getPrototypeOf(object), descriptors);
}
module.exports = { cleanUrl: cleanUrl, cleanText: cleanText, copyField: copyField };

function createPlugin(vendetta, core) {
    var loaded = false;
    var unpatches = [];
    var hooked = [];
    var store = vendetta && vendetta.plugin && vendetta.plugin.storage || {};
    if (store.replaceXWithFxTwitter == null) store.replaceXWithFxTwitter = false;
    function cleanUrl(value) {
        return core.cleanUrl(value, store.replaceXWithFxTwitter === true);
    }
    function cleanText(value) {
        return core.cleanText(value, store.replaceXWithFxTwitter === true);
    }
    function Settings() {
        var common = vendetta && vendetta.metro && vendetta.metro.common;
        var React = common && common.React;
        var RN = common && common.ReactNative;
        if (!React || typeof React.createElement !== "function" || typeof React.useState !== "function" || !RN || !RN.View || !RN.Text || !RN.Switch || !RN.ScrollView) return null;
        var state = React.useState(store.replaceXWithFxTwitter === true);
        var dark = typeof RN.useColorScheme === "function" ? RN.useColorScheme() !== "light" : true;
        var color = dark ? "#f2f3f5" : "#172033";
        var h = React.createElement;
        return h(RN.ScrollView, { style: { flex: 1, backgroundColor: dark ? "#141722" : "#f1f4fa" }, contentContainerStyle: { padding: 18 } },
            h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 12 } },
                h(RN.Text, { style: { color: color, fontSize: 16, flex: 1, marginRight: 12 } }, "Xをfxtwitterに置き換える"),
                h(RN.Switch, {
                    value: state[0], accessibilityLabel: "Xをfxtwitterに置き換える",
                    onValueChange: function (value) {
                        store.replaceXWithFxTwitter = value === true;
                        state[1](value === true);
                    }
                })),
            h(RN.Text, { style: { color: color, fontSize: 14, lineHeight: 21 } },
                "初期設定はオフです。オンにすると送信時とリンクを開く直前に、x.com・twitter.comのリンクをfxtwitter.comへ置き換えます。変更はすぐに保存・反映されます。"),
            h(RN.Text, { style: { color: color, fontSize: 14, lineHeight: 21, marginTop: 12 } },
                "リンクの「?」以降の削除は、この設定がオフでも動作します。"));
    }
    function find() {
        try { return vendetta.metro.findByProps.apply(vendetta.metro, arguments); }
        catch (_) { return null; }
    }
    function hook(target, name, callback) {
        if (!target || typeof target[name] !== "function") return;
        for (var i = 0; i < hooked.length; i++) {
            if (hooked[i].target === target && hooked[i].name === name) return;
        }
        try {
            unpatches.push(vendetta.patcher.before(name, target, callback));
            hooked.push({ target: target, name: name });
        }
        catch (_) { /* Unsupported module: leave original behavior intact. */ }
    }
    function cleanFields(value) {
        value = core.copyField(value, "url", cleanUrl);
        return core.copyField(value, "href", cleanUrl);
    }
    function cleanOpen(args) {
        args[0] = typeof args[0] === "string" ? cleanUrl(args[0]) : cleanFields(args[0]);
    }
    function cleanTap(args) {
        cleanOpen(args);
        var event = args[0];
        if (event && event.nativeEvent) {
            var native = cleanFields(event.nativeEvent);
            if (native !== event.nativeEvent) {
                var descriptors = Object.getOwnPropertyDescriptors(event);
                descriptors.nativeEvent = { value: native, enumerable: true, configurable: true, writable: true };
                args[0] = Object.create(Object.getPrototypeOf(event), descriptors);
            }
        }
    }
    return {
        settings: Settings,
        onLoad: function () {
            if (loaded) return;
            if (!vendetta || !vendetta.patcher || typeof vendetta.patcher.before !== "function" || !vendetta.metro || typeof vendetta.metro.findByProps !== "function") return;
            loaded = true;
            var messages = find("sendMessage");
            hook(messages, "sendMessage", function (args) {
                args[1] = core.copyField(args[1], "content", cleanText);
            });
            var urls = find("openURL");
            hook(urls, "openURL", cleanOpen);
            var common = vendetta.metro.common;
            hook(common && common.url, "openURL", cleanOpen);
            var linking = common && common.ReactNative && common.ReactNative.Linking;
            hook(linking, "openURL", cleanOpen);
            // Discord's click handler receives { href }, not { url }.
            hook(find("handleClick"), "handleClick", cleanOpen);
            // These exports may live in separate modules depending on the build.
            hook(find("handleMessagesTapURLLink"), "handleMessagesTapURLLink", cleanTap);
            hook(find("handleMessagesTapLink"), "handleMessagesTapLink", cleanTap);
        },
        onUnload: function () {
            loaded = false;
            while (unpatches.length) {
                try { unpatches.pop()(); } catch (_) { /* Continue cleanup. */ }
            }
            hooked = [];
        }
    };
}

return createPlugin(vendetta,module.exports);})()
