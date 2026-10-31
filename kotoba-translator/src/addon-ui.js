// Kettu's browser renders plugin/theme catalog entries through a virtualized list.
// Match that public data shape rather than minified component names or global text.
function createAddonIntegration(vendetta, { getTranslator, getConfig, errorMessage }) {
    const { React, ReactNative: RN, clipboard } = vendetta.metro.common;
    const h = (...args) => React.createElement(...args);
    const listeners = new Set();
    const unpatches = [];
    const wrappers = new WeakMap();
    let enabled = false;
    const isAddon = item => item && typeof item.name === "string" && typeof item.description === "string" &&
        typeof item.installUrl === "string" && /^https?:\/\//.test(item.installUrl);

    function AddonTranslation({ addon }) {
        const [result, setResult] = React.useState("");
        const [status, setStatus] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [target, setTarget] = React.useState("");
        const request = React.useRef(0);
        const running = React.useRef(false);
        React.useEffect(() => {
            const reset = () => {
                request.current++; running.current = false;
                setResult(""); setStatus(""); setBusy(false); setTarget("");
            };
            reset();
            listeners.add(reset);
            return () => { request.current++; listeners.delete(reset); };
        }, [addon.installUrl, addon.description]);
        const dark = RN.useColorScheme() !== "light";
        const foreground = dark ? "#ecefff" : "#263761";
        const muted = dark ? "#b7c0d0" : "#525f74";
        const button = (title, onPress, disabled = false) => h(RN.Pressable, {
            onPress, disabled, accessibilityRole: "button", accessibilityLabel: `${addon.name}: ${title}`,
            accessibilityState: { disabled },
            style: { padding: 10, marginRight: 8, marginBottom: 6, borderWidth: 1, borderColor: dark ? "#596794" : "#b2bdd9", borderRadius: 10, opacity: disabled ? 0.5 : 1 },
        }, h(RN.Text, { style: { color: foreground, fontWeight: "600" } }, title));
        const translate = async () => {
            if (!enabled || running.current) return;
            running.current = true;
            const id = ++request.current;
            setBusy(true); setStatus("");
            const c = getConfig();
            setTarget(c.target);
            try {
                const translated = await getTranslator().translate(addon.description, c, value => {
                    if (enabled && request.current === id) setStatus(value);
                });
                if (enabled && request.current === id) { setResult(translated); setStatus(""); }
            } catch (error) {
                if (enabled && request.current === id) setStatus(errorMessage(error));
            } finally {
                if (enabled && request.current === id) { running.current = false; setBusy(false); }
            }
        };
        if (!enabled || !addon.description.trim()) return null;
        return h(RN.View, { style: { paddingHorizontal: 12, paddingBottom: 12 } },
            h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } },
                button(busy ? "説明を翻訳中…" : result ? "訳文を閉じる" : "説明を翻訳", result ? () => { setResult(""); setStatus(""); } : translate, busy),
                !!result && button("訳文をコピー", () => clipboard.setString(result)),
            ),
            !!result && h(RN.View, { style: { padding: 12, borderRadius: 10, backgroundColor: dark ? "#202431" : "#edf1fc" } },
                h(RN.Text, { style: { color: muted, marginBottom: 6, fontSize: 12 } }, `説明の翻訳 · ${target}`),
                h(RN.Text, { selectable: true, style: { color: foreground, lineHeight: 23, fontSize: 15 } }, result),
            ),
            !!status && h(RN.Text, { accessibilityLiveRegion: "polite", style: { color: muted, fontSize: 12, marginTop: 4 } }, status),
        );
    }

    function patchListArgs(args) {
        const props = args[1];
        // No API requests or object mutation during rendering; empty lists need no controls.
        if (!enabled || !props || !Array.isArray(props.data) || !props.data.length ||
            !isAddon(props.data[0]) || typeof props.renderItem !== "function") return;
        const original = props.renderItem;
        let wrapped = wrappers.get(original);
        if (!wrapped) {
            wrapped = function (info, ...rest) {
                const card = original.call(this, info, ...rest);
                if (!enabled || !isAddon(info?.item)) return card;
                return h(RN.View, null, card,
                    h(AddonTranslation, { key: `${info.item.installUrl}\n${info.item.description}`, addon: info.item }));
            };
            wrappers.set(original, wrapped);
            wrappers.set(wrapped, wrapped);
        }
        args[1] = { ...props, renderItem: wrapped };
    }

    return {
        install() {
            if (enabled) return true;
            if (!vendetta.patcher?.before || !vendetta.metro?.findByProps) return false;
            enabled = true;
            try {
                const runtime = vendetta.metro.findByProps("jsx", "jsxs", "Fragment");
                if (runtime) for (const name of ["jsx", "jsxs"]) {
                    if (typeof runtime[name] === "function") unpatches.push(vendetta.patcher.before(name, runtime, patchListArgs));
                }
                if (typeof React.createElement === "function") unpatches.push(vendetta.patcher.before("createElement", React, patchListArgs));
                return unpatches.length > 0;
            } catch {
                this.dispose();
                return false;
            }
        },
        refresh() { for (const listener of listeners) listener(); },
        dispose() {
            enabled = false;
            for (const unpatch of unpatches.splice(0).reverse()) unpatch();
            this.refresh();
        },
    };
}
