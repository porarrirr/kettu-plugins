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
