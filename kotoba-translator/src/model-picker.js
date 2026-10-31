function createOpenRouterModelPicker(vendetta, { getTranslator, errorMessage }) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const h = React.createElement;
    return function OpenRouterModels({ apiKey, selected, backups, onPrimary, onBackup }) {
        const [models, setModels] = React.useState([]);
        const [query, setQuery] = React.useState("");
        const [freeOnly, setFreeOnly] = React.useState(false);
        const [page, setPage] = React.useState(0);
        const [busy, setBusy] = React.useState(false);
        const [status, setStatus] = React.useState("");
        const request = React.useRef(null);
        React.useEffect(() => {
            request.current?.abort(); request.current = null;
            setModels([]); setStatus(""); setBusy(false); setPage(0);
            return () => { request.current?.abort(); request.current = null; };
        }, [apiKey]);
        const dark = RN.useColorScheme() !== "light";
        const color = dark ? "#f2f3f5" : "#172033";
        const muted = dark ? "#b7c0d0" : "#525f74";
        const button = (text, onPress, disabled = false) => h(RN.Pressable, {
            key: text, onPress, disabled, accessibilityRole: "button", accessibilityLabel: text, accessibilityState: { disabled },
            style: { borderWidth: 1, borderColor: "#6579aa", borderRadius: 10, padding: 10, marginBottom: 8, marginRight: 8, opacity: disabled ? 0.4 : 1 },
        }, h(RN.Text, { style: { color, fontWeight: "600" } }, text));
        const load = async () => {
            if (request.current) return;
            const controller = new AbortController(); request.current = controller;
            setBusy(true); setModels([]); setStatus(""); setPage(0);
            try {
                const values = await getTranslator().listOpenRouterModels(apiKey, { signal: controller.signal });
                if (request.current !== controller) return;
                setModels(values);
                setStatus(`${values.length} 件の翻訳向けモデルを取得しました。選択後に「設定を保存」を押してください。`);
            } catch (error) {
                if (request.current === controller) setStatus(errorMessage(error));
            } finally {
                if (request.current === controller) { request.current = null; setBusy(false); }
            }
        };
        const filtered = models.filter(model => (!freeOnly || model.free) && `${model.id} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase()));
        const additional = String(backups || "").split(/[\s,]+/).filter(Boolean);
        const price = value => value != null && String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? `$${(Number(value) * 1000000).toLocaleString()}` : "不明";
        return h(RN.View, { style: { marginBottom: 16 } },
            button(busy ? "OpenRouter モデル取得中…" : "OpenRouter のモデル一覧を取得・更新", load, busy),
            h(RN.Text, { style: { color: muted, marginBottom: 8 } }, apiKey.trim() ? "入力したキーのプロバイダー・プライバシー設定に合うモデルを取得します。" : "キー未入力では公開モデルを取得します。翻訳には OpenRouter の API キーが必要です。"),
            !!status && h(RN.Text, { accessibilityLiveRegion: "polite", style: { color: muted, marginBottom: 8 } }, status),
            models.length > 0 && h(RN.View, null,
                h(RN.TextInput, { value: query, accessibilityLabel: "OpenRouter モデルを検索", placeholder: "名前・モデル ID で検索", placeholderTextColor: muted, autoCapitalize: "none", autoCorrect: false,
                    onChangeText: value => { setQuery(value); setPage(0); }, style: { color, borderColor: "#6579aa", borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 } }),
                button(`無料モデルのみ: ${freeOnly ? "ON" : "OFF"}`, () => { setFreeOnly(!freeOnly); setPage(0); }),
                h(RN.Text, { style: { color: muted, marginBottom: 8 } }, `${filtered.length} 件一致 · 料金は USD / 100万トークン。JSON 出力とテキスト入出力に対応するモデルを表示します。`),
                ...filtered.slice(page * 20, (page + 1) * 20).map(model => h(RN.View, { key: model.id, style: { padding: 12, borderWidth: 1, borderColor: "#6579aa", borderRadius: 10, marginBottom: 10 } },
                    h(RN.Text, { style: { color, fontWeight: "700" } }, model.name),
                    h(RN.Text, { selectable: true, style: { color: muted, marginVertical: 5 } }, model.id),
                    h(RN.Text, { style: { color: muted, marginBottom: 8 } }, model.free ? "入力・出力: 無料" : `入力 ${price(model.promptPrice)} / 出力 ${price(model.completionPrice)}`),
                    button(`${selected === model.id ? "選択中" : "優先モデルにする"}: ${model.id}`, () => onPrimary(model.id), selected === model.id),
                    button(`回転に追加: ${model.id}`, () => onBackup(model.id), selected === model.id || additional.includes(model.id) || additional.length >= 3),
                )),
                h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } },
                    button("前の20件", () => setPage(page - 1), page === 0),
                    button("次の20件", () => setPage(page + 1), (page + 1) * 20 >= filtered.length)),
            ),
        );
    };
}
