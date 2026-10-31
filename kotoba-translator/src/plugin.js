function createPlugin(vendetta, core) {
    const { React, ReactNative: RN, clipboard } = vendetta.metro.common;
    const h = React.createElement;
    const store = vendetta.plugin.storage;
    for (const [key, value] of Object.entries(core.DEFAULTS)) if (store[key] == null) store[key] = value;
    let translator;
    let unregister;
    let active = false;
    let addonUI;
    let addonUIAvailable = false;
    let messageUI;
    const getTranslator = () => {
        if (!active) throw new core.TranslationError("プラグインを有効にしてください。");
        return translator;
    };
    const toast = message => vendetta.ui.toasts.showToast(message);
    const configKeys = Object.keys(core.DEFAULTS);
    let savedConfig;
    const config = () => {
        // Reuse a snapshot across row renders, while still noticing external storage
        // changes (including edits to a backup-key array in place).
        let next;
        for (const key of configKeys) {
            const value = store[key], old = savedConfig?.[key];
            if (!savedConfig || (Array.isArray(value) ? !Array.isArray(old) || value.length !== old.length || value.some((item, i) => item !== old[i]) : value !== old)) {
                if (!next) next = { ...savedConfig };
                next[key] = Array.isArray(value) ? value.slice() : value;
            }
        }
        if (next) savedConfig = next;
        return savedConfig;
    };
    const errorMessage = error => error instanceof core.TranslationError ? error.message : "翻訳に失敗しました。設定を確認してください。";
    const OpenRouterModels = createOpenRouterModelPicker(vendetta, { getTranslator, errorMessage });

    let statistics;
    const StatisticsScreen = createStatisticsScreen(vendetta);
    const makeTranslator = () => new core.Translator({
        persistentCache: { load: () => store.translationCache, save: rows => { store.translationCache = rows; } },
        onRequest: event => statistics.start(event),
    });

    function Settings() {
        const [tab, setTab] = React.useState("translate");
        const [draft, setDraft] = React.useState(config);
        const [text, setText] = React.useState("");
        const [result, setResult] = React.useState("");
        const [status, setStatus] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [bulk, setBulk] = React.useState(false);
        const [automaticStatus, setAutomaticStatus] = React.useState(() => messageUI?.status());
        const alive = React.useRef(true);
        const running = React.useRef(false);
        const request = React.useRef(0);
        React.useEffect(() => {
            request.current++;
            running.current = false;
            setBusy(false); setResult(""); setStatus("");
            return () => { request.current++; };
        }, [draft, text, bulk]);
        React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
        React.useEffect(() => {
            const timer = setInterval(() => {
                const value = messageUI?.status();
                setAutomaticStatus(old => JSON.stringify(old) === JSON.stringify(value) ? old : value);
            }, 1000);
            return () => clearInterval(timer);
        }, []);
        const dark = RN.useColorScheme() !== "light";
        const color = dark ? "#f2f3f5" : "#172033";
        const muted = dark ? "#b7c0d0" : "#525f74";
        const surface = dark ? "#202431" : "#ffffff";
        const background = dark ? "#141722" : "#f1f4fa";
        const border = dark ? "#444d63" : "#cad2e1";
        const set = (key, value) => setDraft(old => ({ ...old, [key]: value }));
        const label = (value, extra = {}) => h(RN.Text, { style: { color, fontSize: 15, ...extra } }, value);
        const note = value => label(value, { color: muted, fontSize: 13, lineHeight: 20 });
        const button = (title, onPress, selected = false, disabled = false) => h(RN.Pressable, {
            key: title, onPress, disabled, accessibilityRole: "button", accessibilityLabel: title,
            accessibilityState: { disabled, selected },
            style: { backgroundColor: selected ? "#4659d8" : surface, borderWidth: 1, borderColor: selected ? "#6579ff" : border,
                padding: 12, borderRadius: 12, opacity: disabled ? 0.45 : 1, marginBottom: 8, marginRight: 8 },
        }, label(title, { color: selected ? "#ffffff" : color, fontWeight: "600" }));
        const row = children => h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } }, children);
        const input = (title, value, onChangeText, options = {}) => h(RN.View, { style: { marginBottom: 14 } },
            label(title, { fontWeight: "600", marginBottom: 7 }),
            h(RN.TextInput, {
                value: String(value), onChangeText, accessibilityLabel: title, placeholderTextColor: muted,
                autoCapitalize: "none", autoCorrect: false,
                style: { backgroundColor: surface, color, borderColor: border, borderWidth: 1, borderRadius: 12,
                    padding: 12, fontSize: 16, minHeight: options.multiline ? 128 : 48, textAlignVertical: "top" },
                ...options,
            }));
        const save = () => {
            for (const key of Object.keys(core.DEFAULTS)) store[key] = draft[key];
            store.intervalMs = Math.min(60000, Math.max(1000, Number(draft.intervalMs) || 3000));
            setDraft(config());
            translator?.clearCache({ persistent: false });
            translator?.blocked.clear();
            translator?.blockedModels.clear();
            addonUI?.refresh();
            messageUI?.refresh();
            toast("設定を保存しました");
        };
        const translate = async () => {
            if (running.current) return;
            running.current = true;
            const id = ++request.current;
            setBusy(true); setResult(""); setStatus("");
            let engine;
            const current = () => alive.current && request.current === id && active && translator === engine;
            try {
                engine = getTranslator();
                const report = value => { if (current()) setStatus(value); };
                const value = bulk
                    ? (await engine.translateMany(text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean), draft, report)).join("\n\n")
                    : await engine.translate(text, draft, report);
                if (current()) { setResult(value); setStatus("翻訳が完了しました"); }
            } catch (error) {
                if (current()) setStatus(errorMessage(error));
            } finally {
                if (request.current === id) { running.current = false; if (alive.current) setBusy(false); }
            }
        };
        return h(RN.KeyboardAvoidingView, { style: { flex: 1, backgroundColor: background }, behavior: RN.Platform.OS === "ios" ? "padding" : undefined },
            h(RN.ScrollView, { keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 18, paddingBottom: 64 } },
                label("ことばを、もっと自由に。", { fontSize: 25, fontWeight: "700", marginBottom: 6 }),
                note("必要な文章だけ翻訳。結果を確認してからコピーできます。"),
                h(RN.View, { style: { height: 18 } }),
                row([button("翻訳", () => setTab("translate"), tab === "translate"), button("設定", () => setTab("settings"), tab === "settings"), button("統計", () => setTab("statistics"), tab === "statistics")]),
                tab === "statistics" && statistics ? h(StatisticsScreen, { statistics }) : h(RN.View, null,
                button(`メッセージの自動翻訳: ${draft.autoTranslateMessages ? "ON" : "OFF"}`, () => {
                    const value = !draft.autoTranslateMessages;
                    set("autoTranslateMessages", value); store.autoTranslateMessages = value;
                    messageUI?.refresh();
                }, draft.autoTranslateMessages),
                note("表示中のメッセージを保存済みの API 設定で翻訳し、本文の表示を置き換えます。原文の編集・投稿やダイアログ表示は行いません。OFF にすると原文に戻ります。"),
                note(automaticStatus?.label || "自動翻訳の状態を確認しています…"),
                automaticStatus && note(`API 送信 ${automaticStatus.sent} 回 · 通信中 ${automaticStatus.active} 件${automaticStatus.detail ? ` · ${automaticStatus.detail}` : ""}${automaticStatus.error ? ` · ${automaticStatus.error}` : ""}`),
                button("表示中のメッセージを再翻訳", () => {
                    const value = messageUI?.retryVisible();
                    if (value) toast(value.message);
                    setAutomaticStatus(messageUI?.status());
                }, false, !automaticStatus?.available || automaticStatus.pending > 0),
                h(RN.View, { style: { height: 14 } }),
                label("翻訳サービス", { fontWeight: "600", marginBottom: 8 }),
                row([...[ ["deepl", "DeepL"], ["openai", "OpenAI"], ["deepseek", "DeepSeek"], ["gemini", "Gemini"], ["openrouter", "OpenRouter"], ["custom", "カスタム"] ].map(([id, name]) => button(name, () => set("provider", id), draft.provider === id, busy))]),
                tab === "translate" ? h(RN.View, null,
                    input("翻訳先の言語コード", draft.target, value => set("target", value), { placeholder: "JA / EN-US / ko / zh-Hant", editable: !busy, maxLength: 40 }),
                    row([["JA", "日本語"], ["EN-US", "英語"], ["KO", "韓国語"], ["ZH", "中国語"], ["FR", "フランス語"]]
                        .map(([id, name]) => button(name, () => set("target", id), draft.target.toUpperCase() === id, busy))),
                    note("自由入力で各サービスの対応言語を指定できます。DeepL の対応外言語には LLM をお試しください。"),
                    h(RN.View, { style: { height: 14 } }),
                    button(bulk ? "一括翻訳: ON（空行で区切る）" : "一括翻訳: OFF", () => setBulk(!bulk), bulk, busy),
                    bulk && note("空行ごとに別の文章として翻訳します。最大 32 件。1 リクエストに最大 8 件・合計 6,000 文字をまとめます。コード内の空行も区切りになるため、コードを含む文章は OFF を推奨します。"),
                    input("翻訳する文章", text, setText, { multiline: true, maxLength: bulk ? 48000 : 6000, editable: !busy, placeholder: bulk ? "文章 1\n\n文章 2\n\n文章 3" : "文章を入力・貼り付け" }),
                    note(`${text.length.toLocaleString()} 文字 · ${draft.providerRotation ? "登録済みプロバイダーを順番に使用" : draft.autoSwitch ? "制限時は登録済みの別 API に自動切替" : "選択中の API のみ使用"}`),
                    h(RN.View, { style: { height: 12 } }),
                    button(busy ? "待機・翻訳中…" : "翻訳する", translate, true, busy || !text.trim()),
                    button("言語設定を保存", save, false, busy),
                    h(RN.Text, { accessibilityLiveRegion: "polite", style: { color: muted, lineHeight: 22, marginVertical: 10 } }, status),
                    !!result && h(RN.View, { style: { padding: 16, backgroundColor: surface, borderRadius: 14, borderWidth: 1, borderColor: border } },
                        label("翻訳結果", { fontWeight: "700", marginBottom: 10 }),
                        h(RN.Text, { selectable: true, style: { color, fontSize: 16, lineHeight: 25, marginBottom: 14 } }, result),
                        button("結果をコピー", () => { clipboard.setString(result); toast("コピーしました"); }),
                    ),
                ) : h(RN.View, null,
                    note("1. サービスを選択 → 2. API キーを入力 → 3. 保存 →「翻訳」で試す"),
                    h(RN.View, { style: { height: 16 } }),
                    input(draft.provider === "custom" ? "API キー（キー不要のサーバーは空欄）" : "API キー", draft[`${draft.provider}Key`], value => set(`${draft.provider}Key`, value), { secureTextEntry: true, placeholder: draft.provider === "custom" ? "ローカルサーバーなどは空欄のまま" : "利用するサービスのキー", textContentType: "none" }),
                    ...(draft[`${draft.provider}BackupKeys`] || []).map((key, index) => h(RN.View, { key: `${draft.provider}-${index}` },
                        input(`予備 API キー ${index + 1}`, key, value => {
                            const keys = [...draft[`${draft.provider}BackupKeys`]]; keys[index] = value; set(`${draft.provider}BackupKeys`, keys);
                        }, { secureTextEntry: true, textContentType: "none" }),
                        button(`予備キー ${index + 1} を削除`, () => set(`${draft.provider}BackupKeys`, draft[`${draft.provider}BackupKeys`].filter((_, i) => i !== index))),
                    )),
                    button("予備 API キーを追加", () => set(`${draft.provider}BackupKeys`, [...draft[`${draft.provider}BackupKeys`], ""]), false, (draft[`${draft.provider}BackupKeys`] || []).length >= 3),
                    note("キーは Kettu のプラグイン領域に保存します（暗号化保管ではありません）。他人とストレージを共有しないでください。"),
                    h(RN.View, { style: { height: 14 } }),
                    draft.provider === "deepl" ? row([button("API Free", () => set("deeplPlan", "free"), draft.deeplPlan === "free"), button("API Pro", () => set("deeplPlan", "pro"), draft.deeplPlan === "pro")])
                        : h(RN.View, null,
                            draft.provider === "custom" && h(RN.View, null,
                                label("API 形式", { fontWeight: "600", marginBottom: 8 }),
                                row([["openai-chat", "OpenAI Chat"], ["openai-responses", "OpenAI Responses"], ["anthropic", "Anthropic Messages"]].map(([id, name]) => button(name, () => set("customFormat", id), draft.customFormat === id, busy))),
                                input("ベース URL", draft.customBaseUrl, value => set("customBaseUrl", value), { placeholder: draft.customFormat === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1" }),
                                note(draft.customFormat === "anthropic" ? "…/v1 には /messages、それ以外には /v1/messages を付けて送信します。すでに …/messages で終わる URL はそのまま使います。" : draft.customFormat === "openai-responses" ? "末尾に /responses を付けて送信します。すでに …/responses で終わる URL はそのまま使います。" : "末尾に /chat/completions を付けて送信します。すでに …/chat/completions で終わる URL はそのまま使います。"),
                                h(RN.View, { style: { height: 14 } }),
                            ),
                            input("優先モデル ID", draft[`${draft.provider}Model`], value => set(`${draft.provider}Model`, value), { placeholder: "API で利用できるモデル ID" }),
                            input(draft.provider === "gemini" ? "ローテーション用モデル ID（追加数の制限なし）" : "ローテーション用モデル ID（追加 3 個まで）", draft[`${draft.provider}BackupModels`], value => set(`${draft.provider}BackupModels`, value), { placeholder: "モデル ID を改行またはカンマで区切る", multiline: true, ...(draft.provider === "gemini" ? {} : { maxLength: 500 }) }),
                            draft.provider === "openrouter" && h(OpenRouterModels, {
                                apiKey: draft.openrouterKey, selected: draft.openrouterModel, backups: draft.openrouterBackupModels,
                                onPrimary: id => set("openrouterModel", id),
                                onBackup: id => setDraft(old => {
                                    const models = [...new Set(String(old.openrouterBackupModels || "").split(/[\s,]+/).filter(Boolean))];
                                    if (id !== old.openrouterModel && !models.includes(id) && models.length < 3) models.push(id);
                                    return { ...old, openrouterBackupModels: models.join("\n") };
                                }),
                            }),
                            note("優先モデルと追加モデルを順番に使用します。制限・過負荷中の組合せはスキップ。Gemini / OpenAI / DeepSeek / OpenRouter / カスタムに対応します。"),
                        ),
                    input("翻訳元の言語コード（自動検出: auto）", draft.source, value => set("source", value), { placeholder: "auto", maxLength: 40 }),
                    input("通常の呼び出し間隔（ミリ秒）", draft.intervalMs, value => set("intervalMs", value), { keyboardType: "number-pad", maxLength: 5 }),
                    note("既定 3,000 ms、設定範囲 1,000〜60,000 ms。通常はプロバイダー・キーごとに間隔を管理。失敗後の別モデルへの切替は同じキーで最短1,000 ms、使える別サービス・予備キーへは追加待機なし。API指定の待機・クールダウンは維持します。同時リクエスト 1 件、翻訳待ち 32 件。350 ms 以内の同じ設定の翻訳を最大 8 件に集約し、翻訳結果は最大100件・30日間保存し、再起動後も使います。"),
                    h(RN.View, { style: { height: 14 } }),
                    button(`API 自動切替: ${draft.autoSwitch ? "ON" : "OFF"}`, () => set("autoSwitch", !draft.autoSwitch), draft.autoSwitch),
                    button(`プロバイダーローテーション: ${draft.providerRotation ? "ON" : "OFF"}`, () => set("providerRotation", !draft.providerRotation), draft.providerRotation),
                    button(`モデルローテーション: ${draft.modelRotation ? "ON" : "OFF"}`, () => set("modelRotation", !draft.modelRotation), draft.modelRotation),
                    note("プロバイダー回転は初期 OFF。ON では選択中サービスから始め、キーと必要なモデルを登録済みのサービスをリクエストごとに巡回します。待機中・利用不可の候補はスキップし、キャッシュ利用では順番を進めません。API 自動切替 OFF でも各サービスの主キーで巡回します。翻訳文は巡回先の外部サービスにも送信されます。"),
                    note("API 切替とモデル回転は独立設定です。キーごとの間隔を守り、キー＋モデルごとの 429・529 等の待機状態を管理します。API 切替 ON では予備キー・他サービスも使用。モデル回転 ON では呼び出すたびに次のモデルへ進みます。翻訳文は切替先にも送信されます。Gemini の利用枠はプロジェクト単位で共有され、キーを増やしても枠が増えるとは限りません。"),
                    h(RN.View, { style: { height: 16 } }),
                    button("設定を保存", save, true),
                    note(addonUIAvailable ? "アドオンブラウザーの各カードで「説明を翻訳」を押すと、この保存済み設定で翻訳します。反映されない場合はブラウザーを開き直してください。" : "この環境ではアドオンブラウザーへの翻訳ボタン追加を確認できませんでした。説明をコピーし、「翻訳」で翻訳できます。"),
                    button("翻訳キャッシュを消去", () => { translator?.clearCache(); messageUI?.refresh(); addonUI?.refresh(); toast("保存済み・メモリ内の翻訳キャッシュを消去しました"); }),
                    button("すべての API キーを削除", () => RN.Alert.alert("API キーの削除", `保存済みの ${core.PROVIDERS.length} サービスのキーを削除します。`, [
                        { text: "キャンセル", style: "cancel" },
                        { text: "削除", style: "destructive", onPress: () => {
                            for (const provider of core.PROVIDERS) { store[`${provider}Key`] = ""; store[`${provider}BackupKeys`] = []; }
                            setDraft(old => ({ ...old, ...Object.fromEntries(core.PROVIDERS.flatMap(provider => [[`${provider}Key`, ""], [`${provider}BackupKeys`, []]])) }));
                            translator?.dispose();
                            if (active) translator = makeTranslator();
                            addonUI?.refresh();
                            messageUI?.refresh();
                            toast("API キーを削除しました");
                        } },
                    ])),
                    note("自動翻訳 ON の間は表示中の本文を選択中の翻訳サービスへ送信します。API 利用料は各サービスの契約に従います。"),
                ),
                ),
            ));
    }

    return {
        getTranslationStatus() { return messageUI?.status(); },
        refreshVisibleTranslations() { return messageUI?.retryVisible(); },
        clearTranslationCache() { translator?.clearCache(); messageUI?.refresh(); addonUI?.refresh(); },
        onLoad() {
            if (active) return;
            active = true;
            if (!statistics) statistics = core.createRequestStatistics({ load: () => store.requestStatistics, save: value => { store.requestStatistics = value; } });
            translator = makeTranslator();
            addonUI = createAddonIntegration(vendetta, { getTranslator, getConfig: config, errorMessage });
            addonUIAvailable = addonUI.install();
            messageUI = createMessageIntegration(vendetta, { getTranslator, getConfig: config, errorMessage, containsJapanese: core.containsJapanese });
            messageUI.install();
            unregister = vendetta.commands.registerCommand({
                name: "translate", description: "文章を翻訳してクリップボードにコピーします", options: [
                    { name: "text", description: "翻訳する文章", type: 3, required: true },
                    { name: "target", description: "翻訳先の言語コード（省略時は保存した言語）", type: 3 },
                ],
                async execute(args) {
                    const text = args.find(arg => arg.name === "text")?.value || "";
                    const target = args.find(arg => arg.name === "target")?.value || store.target;
                    const engine = getTranslator();
                    try {
                        toast("翻訳を受け付けました");
                        const result = await engine.translate(text, { ...config(), target });
                        if (!active || translator !== engine) return;
                        clipboard.setString(result);
                        toast("翻訳結果をコピーしました");
                    } catch (error) { if (active && translator === engine) toast(errorMessage(error)); }
                    // Kettu sends returned command objects to the channel. Always return void.
                },
            });
        },
        onUnload() {
            active = false;
            messageUI?.dispose(); messageUI = undefined;
            addonUI?.dispose(); addonUI = undefined; addonUIAvailable = false;
            unregister?.(); unregister = undefined;
            translator?.dispose(); translator = undefined;
        },
        settings: Settings,
    };
}
