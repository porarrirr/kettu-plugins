(function(){var module={exports:{}};
// ES5 syntax intentionally: this also runs inside the iOS expression evaluator.
function cleanUrl(value) {
    if (typeof value !== "string") return value;
    // Exact host check avoids touching lookalike domains or credentials.
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|x\.com|twitter\.com)(?=[:/?#]|$)(?::\d+)?(?:[/?#]|$)/i.test(value)) return value;
    var query = value.indexOf("?");
    var fragment = value.indexOf("#");
    return query < 0 || (fragment >= 0 && fragment < query) ? value : value.slice(0, query);
}
function cleanText(value) {
    if (typeof value !== "string") return value;
    return value.replace(/https?:\/\/[^\s<>"'`\u3000\u3001\u3002\uff01\uff1f\uff09\u300d\u300f]+/gi, function (token) {
        // Keep surrounding Markdown and sentence punctuation out of the URL.
        var suffix = "";
        while (/[)\]},.!;:]$/.test(token)) {
            suffix = token.slice(-1) + suffix;
            token = token.slice(0, -1);
        }
        return cleanUrl(token) + suffix;
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
        value = core.copyField(value, "url", core.cleanUrl);
        return core.copyField(value, "href", core.cleanUrl);
    }
    function cleanOpen(args) {
        args[0] = typeof args[0] === "string" ? core.cleanUrl(args[0]) : cleanFields(args[0]);
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
        onLoad: function () {
            if (loaded) return;
            if (!vendetta || !vendetta.patcher || typeof vendetta.patcher.before !== "function" || !vendetta.metro || typeof vendetta.metro.findByProps !== "function") return;
            loaded = true;
            var messages = find("sendMessage");
            hook(messages, "sendMessage", function (args) {
                args[1] = core.copyField(args[1], "content", core.cleanText);
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
