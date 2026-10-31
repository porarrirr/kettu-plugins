function createStatisticsScreen(vendetta) {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const h = React.createElement;
    const names = { deepl: "DeepL", openai: "OpenAI", deepseek: "DeepSeek", gemini: "Gemini", openrouter: "OpenRouter", custom: "カスタム" };
    const accents = { deepl: "#7c83ff", openai: "#25ab88", deepseek: "#528bfa", gemini: "#b578eb", openrouter: "#e88a46", custom: "#64748b" };
    return function StatisticsScreen({ statistics }) {
        const [days, setDays] = React.useState(7);
        const [provider, setProvider] = React.useState("");
        const [page, setPage] = React.useState(0);
        const read = () => statistics.snapshot(days, provider);
        const [data, setData] = React.useState(read);
        React.useEffect(() => {
            const update = () => { const next = read(); setData(old => JSON.stringify(old) === JSON.stringify(next) ? old : next); };
            update();
            const timer = setInterval(update, 1000);
            return () => clearInterval(timer);
        }, [statistics, days, provider]);
        const dark = RN.useColorScheme() !== "light";
        const color = dark ? "#f2f3f5" : "#172033", muted = dark ? "#b7c0d0" : "#525f74";
        const surface = dark ? "#202431" : "#ffffff", track = dark ? "#353c50" : "#e6eaf3";
        const text = (value, style = {}) => h(RN.Text, { style: { color, fontSize: 14, ...style } }, value);
        const note = value => text(value, { color: muted, fontSize: 12, lineHeight: 19, marginVertical: 6 });
        const number = value => value.toLocaleString();
        const button = (title, press, selected = false, disabled = false) => h(RN.Pressable, {
            key: title, onPress: press, disabled, accessibilityRole: "button", accessibilityLabel: title,
            accessibilityState: { selected, disabled },
            style: { padding: 11, borderRadius: 10, marginRight: 7, marginBottom: 8, backgroundColor: selected ? "#4659d8" : surface, opacity: disabled ? 0.45 : 1 },
        }, text(title, { color: selected ? "#ffffff" : color, fontWeight: "600" }));
        const row = children => h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } }, children);
        const card = children => h(RN.View, { style: { padding: 16, borderRadius: 16, backgroundColor: surface, marginBottom: 14 } }, children);
        const heading = title => text(title, { fontSize: 17, fontWeight: "700", marginBottom: 12 });
        const bar = (amount, total, tint) => h(RN.View, { accessible: false, style: { height: 8, backgroundColor: track, borderRadius: 4, overflow: "hidden", marginVertical: 9 } },
            h(RN.View, { style: { width: `${total ? Math.min(100, amount / total * 100) : 0}%`, height: 8, borderRadius: 4, backgroundColor: tint } }));
        const allSent = data.providers.reduce((sum, value) => sum + value.sent, 0);
        const total = data.total, completed = total.success + total.failed;
        const pending = total.sent - completed - total.interrupted;
        const pageCount = Math.max(1, Math.ceil(data.models.length / 15)), currentPage = Math.min(page, pageCount - 1);
        const change = (d, p) => { setDays(d); setProvider(p); setPage(0); setData(statistics.snapshot(d, p)); };
        const metric = (title, value, tint) => h(RN.View, { key: title, style: { width: "50%", paddingRight: 8, marginBottom: 16 } },
            text(title, { color: muted, fontSize: 12, marginBottom: 5 }), text(value, { fontSize: 28, fontWeight: "700", color: tint || color }));
        return h(RN.View, null,
            heading("リクエスト統計"),
            note("どこへ、どれだけ送ったか。翻訳の実際の送信回数を記録します。"),
            row([[1, "今日"], [7, "7日間"], [30, "30日間"]].map(([value, title]) => button(title, () => change(value, provider), days === value))),
            row([button("すべて", () => change(days, ""), !provider), ...Object.keys(names).map(id => button(names[id], () => change(days, id), provider === id))]),
            card([
                text(provider ? names[provider] : "全プロバイダー", { fontWeight: "700", marginBottom: 16 }),
                row([metric("送信リクエスト", number(total.sent)), metric("成功率", completed ? `${Math.round(total.success / completed * 100)}%` : "—", dark ? "#6bdabc" : "#12755e"),
                    metric("失敗リクエスト", number(total.failed), dark ? "#ffb19d" : "#b34729"), metric("送信した文章", number(total.texts))]),
                text(`成功 ${number(total.success)} 回   ·   中断・結果不明 ${number(total.interrupted)} 回   ·   処理中 ${number(pending)} 回`, { color: muted, fontSize: 12, lineHeight: 20 }),
                note(`送信文字数 ${number(total.characters)} 文字 · 成功率は結果確定分（成功＋失敗）で計算`),
            ]),
            !allSent && card([heading("まだ送信記録がありません"), note("翻訳リクエストを送ると、ここにグラフとモデル別の内訳が表示されます。追加前の履歴は復元できません。")]),
            !!allSent && card([
                heading("プロバイダー別の送信割合"),
                note("全プロバイダーの比較 · 押すとモデルを絞り込み"),
                ...data.providers.map(value => h(RN.Pressable, {
                    key: value.provider, accessibilityRole: "button", accessibilityLabel: `${names[value.provider]}、${number(value.sent)} 回、${Math.round(value.sent / allSent * 100)}%、モデルを表示`,
                    accessibilityState: { selected: provider === value.provider }, onPress: () => change(days, value.provider), style: { marginBottom: 12 },
                }, row([text(names[value.provider], { fontWeight: "600", flexGrow: 1 }), text(`${number(value.sent)} 回  ·  ${Math.round(value.sent / allSent * 100)}%`)]), bar(value.sent, allSent, accents[value.provider]))),
            ]),
            !!allSent && card([
                heading(`モデル別の内訳${provider ? ` · ${names[provider]}` : ""}`),
                note("送信数の多い順 · 割合は選択中の範囲に対する比率"),
                !data.models.length && note("このプロバイダーの送信記録はありません。"),
                ...data.models.slice(currentPage * 15, (currentPage + 1) * 15).map(value => h(RN.View, { key: JSON.stringify([value.provider, value.model]), style: { marginBottom: 18 } },
                    text(names[value.provider], { color: muted, fontSize: 12, marginBottom: 4 }),
                    text(value.model || "DeepL（モデル指定なし）", { fontWeight: "600", lineHeight: 21 }),
                    bar(value.sent, total.sent, accents[value.provider]),
                    text(`${number(value.sent)} 回 · ${Math.round(value.sent / total.sent * 100)}%`, { fontSize: 18, fontWeight: "700" }),
                    note(`成功 ${number(value.success)} · 失敗 ${number(value.failed)} · 中断・不明 ${number(value.interrupted)} · 処理中 ${number(value.sent - value.success - value.failed - value.interrupted)}`),
                    text(`文章 ${number(value.texts)} 件 · ${number(value.characters)} 文字`, { color: muted, fontSize: 12 }),
                )),
                pageCount > 1 && row([button("前の15件", () => setPage(currentPage - 1), false, currentPage === 0), button("次の15件", () => setPage(currentPage + 1), false, currentPage === pageCount - 1), note(`${currentPage + 1} / ${pageCount}`)]),
            ]),
            note("1回の一括送信は1リクエスト。切替・再試行・通信失敗は各1回に数えます。キャッシュ・重複要求の共用・送信前の取消・モデル一覧取得は含みません。料金やトークン数ではありません。OpenRouter は指定モデルで集計し、内部の配信先は判別しません。"),
            note("端末の現地日付で直近30日分を保存（最大3,000組の日付・プロバイダー・モデル）。再起動後も保持します。"),
            button("統計をリセット", () => RN.Alert.alert("統計をリセット", "保存済みの送信統計を消去します。進行中の古い結果も統計へ戻しません。", [
                { text: "キャンセル", style: "cancel" },
                { text: "リセット", style: "destructive", onPress: () => { statistics.clear(); setData(read()); setPage(0); } },
            ])),
        );
    };
}
