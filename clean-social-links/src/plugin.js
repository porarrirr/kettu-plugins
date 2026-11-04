function createPlugin(vendetta, core) {
    var loaded = false;
    var unpatches = [];
    var hooked = [];
    var store = vendetta && vendetta.plugin && vendetta.plugin.storage || {};
    var defaults = { cleanXLinks: true, cleanAmazonLinks: true, cleanInstagramLinks: true, cleanAliExpressLinks: true, replaceXWithFxTwitter: false };
    var settingKeys = Object.keys(defaults);
    for (var i = 0; i < settingKeys.length; i++) {
        var key = settingKeys[i];
        if (store[key] == null) store[key] = defaults[key];
    }
    function settingsValues() {
        var values = {};
        for (var i = 0; i < settingKeys.length; i++) {
            var key = settingKeys[i];
            values[key] = defaults[key] ? store[key] !== false : store[key] === true;
        }
        return values;
    }
    function cleanUrl(value) {
        return core.cleanUrl(value, store.replaceXWithFxTwitter === true, store);
    }
    function cleanText(value) {
        return core.cleanText(value, store.replaceXWithFxTwitter === true, store);
    }
    function Settings() {
        var common = vendetta && vendetta.metro && vendetta.metro.common;
        var React = common && common.React;
        var RN = common && common.ReactNative;
        if (!React || typeof React.createElement !== "function" || typeof React.useState !== "function" || !RN || !RN.View || !RN.Text || !RN.Switch || !RN.ScrollView) return null;
        var state = React.useState(settingsValues());
        var dark = typeof RN.useColorScheme === "function" ? RN.useColorScheme() !== "light" : true;
        var color = dark ? "#f2f3f5" : "#172033";
        var h = React.createElement;
        function toggle(key, title, disabled) {
            return h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 12 } },
                h(RN.Text, { style: { color: color, fontSize: 16, flex: 1, marginRight: 12 } }, title),
                h(RN.Switch, {
                    value: state[0][key], disabled: disabled === true, accessibilityLabel: title,
                    accessibilityState: { disabled: disabled === true },
                    onValueChange: function (value) {
                        if (disabled) return;
                        store[key] = value === true;
                        state[1](settingsValues());
                    }
                }));
        }
        return h(RN.ScrollView, { style: { flex: 1, backgroundColor: dark ? "#141722" : "#f1f4fa" }, contentContainerStyle: { padding: 18 } },
            toggle("cleanXLinks", "Xのリンクを清掃"),
            toggle("cleanAmazonLinks", "Amazonのリンクを清掃"),
            toggle("cleanInstagramLinks", "Instagramのリンクを清掃"),
            toggle("cleanAliExpressLinks", "AliExpressの商品リンクを清掃"),
            h(RN.Text, { style: { color: color, fontSize: 14, lineHeight: 21, marginBottom: 18 } },
                "オンのサイトだけ、送信時とリンクを開く直前に「?」以降を削除します。各サイトは初期オンです。変更はすぐに保存・反映されます。AliExpressは商品ページのみが対象です。"),
            toggle("replaceXWithFxTwitter", "Xをfxtwitterに置き換える", !state[0].cleanXLinks),
            h(RN.Text, { style: { color: color, fontSize: 14, lineHeight: 21 } },
                "fxtwitterへの置換は初期オフです。Xのリンク清掃がオンのときだけ利用できます。Xの清掃をオフにすると、置換も停止します。"));
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
