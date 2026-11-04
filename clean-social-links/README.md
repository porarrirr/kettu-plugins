# Clean Social Links

Kettu / Vendetta 互換の独立したプラグインです。有効にすると Instagram・X（旧 Twitter）・Amazon のリンクと AliExpress の商品リンクの `?` とそれ以降を、メッセージ送信時とリンクを開く直前に自動削除します。Xリンクを `fxtwitter.com` に置き換える設定もあります（初期設定はオフ）。

例: `https://www.instagram.com/p/ABC/?igsh=123` → `https://www.instagram.com/p/ABC/`

Amazon の例: `https://www.amazon.co.jp/dp/B012345678?tag=example&ref_=share` → `https://www.amazon.co.jp/dp/B012345678`

## 導入・使い方

1. Kettu のプラグイン追加画面を開きます。
2. `https://porarrirr.github.io/kettu-plugins/clean-social-links/` を入力してインストールします（末尾 `/` を含む）。
3. 「Clean Social Links」を有効にします。プラグイン設定でX・Amazon・Instagram・AliExpressのリンク清掃を個別にオン／オフできます（各サイト初期オン）。通常どおりメッセージを送信したり、リンクを開いたりしてください。必要な場合だけプラグイン設定の「Xをfxtwitterに置き換える」をオンにします。設定は即時保存・反映されます。
4. 無効にすると元の処理へ戻ります。再有効化も可能です。

## 対象と制約

- HTTP / HTTPS の `instagram.com`・`x.com`・`twitter.com` とそのサブドメインが対象です。
- Amazon は `amazon.co.jp`・`amazon.com`・`amazon.co.uk`・`amazon.de`・`amazon.fr`・`amazon.it`・`amazon.es`・`amazon.ca`・`amazon.com.au`・`amazon.in`・`amazon.com.br`・`amazon.com.mx`・`amazon.nl`・`amazon.se`・`amazon.pl`・`amazon.com.be`・`amazon.ie`・`amazon.com.tr`・`amazon.ae`・`amazon.sa`・`amazon.sg`・`amazon.eg`・`amazon.co.za`・`amazon.cn` とそのサブドメイン、および `amzn.asia`・`amzn.to` とそのサブドメインが対象です。別サイトやその他の短縮 URL（`t.co` など）には触れません。
- 短縮 URL は入力された URL の `?` 以降だけを削除します。展開やリダイレクト先を調べる通信はしません。Amazon のパス内の `/ref=...` は保持します。短縮リンクの転送先にある紹介タグや既存の紹介セッションには対応しないため、Amazonアフィリエイトの完全な遮断を保証する機能ではありません。
- 送信本文中の複数リンク、Markdown リンク、自動リンクに対応します。末尾の一般的な句読点や閉じ括弧は残します。空白のない文章と URL の境界や、URL 自体に含まれる末尾の括弧・句読点には曖昧さがあります。
- 削除対象のリンクでは、追跡用に限らず、最初の `?` 以降をすべて削除します。検索などクエリが必要なリンクでは機能が変わります。`#` の後にだけ現れる `?` はクエリではないので保持します。
- 送信時は送信引数のコピーを変更します。入力欄の表示や送信済み履歴を直接書き換えません。メッセージの編集・添付ファイルの内容は対象外です。
- 開く際は共通 URL API と検索で見つかる `openURL`、React Native Linking、`handleClick` の `href`、ネイティブメッセージのリンクタップ処理を対象にします。ネイティブの各タップ処理は独立して検索し、同じ API の重複フックを避けます。Discord の内部 API に依存するため、更新で一部経路が変わる可能性があります。必要なモジュールがない環境では該当機能をスキップします。
- アプリ外から直接開くリンクや、これらの処理を通らない経路は対象外です。
- プラグイン自身による外部通信やリンク本文・ログの保存はありません。各サイトのリンク清掃とfxtwitter置換のオン／オフを専用ストレージに保存します。オンでリンクを開くと移動先は fxtwitter.com になります。他プラグインへの実行時依存はありません。

## ビルド・検証

Node.js 22 以上で、リポジトリのルートから実行します。追加パッケージは不要です。

```sh
npm --prefix clean-social-links run check
```

ソースから単一の式である `index.js` と SHA-256 付き `manifest.json` を同時生成します。実機の式評価との互換性を考慮し、ソース自体を ES5 の構文で記述しています（native async / class / ループ内の非同期処理は使用しません）。

テストは Node のモックで、対象ホスト判定、複数リンク、コピーによる送信、URL とネイティブイベントの処理、停止・再起動、内部 API 不在、配布式の評価とハッシュを確認します。この公開用構成では実機での起動／表示／送信／停止／再起動を再検証していません。実機確認時には、実際に送信する前に自分用チャンネルで対象 URL と他サイト URL を含む本文を使い、リンクを開いた先の URL も確認してください。

## Amazon 対応（2026-11-02）

送信時・リンクを開く直前の対象に Amazon を追加しました。国別ドメイン・短縮 URL、類似ドメインの除外、Markdown 内のリンク、送信／リンクタップと停止時の復元を Node のモックで検証しています。配布 JS とマニフェストのハッシュを再生成しました。実機への反映・実機動作確認は行っていません。

## fxtwitter 置換設定（2026-11-04）

「Xをfxtwitterに置き換える」を追加しました。新規導入・既存設定からの更新とも初期設定はオフです。オフでは従来どおり `?` 以降だけを削除します。オンでは HTTP / HTTPS の `x.com`・`twitter.com` とそのサブドメインを `fxtwitter.com` に置換します。パスは保持します。

例: `https://x.com/user/status/123?s=20` → オフ: `https://x.com/user/status/123` / オン: `https://fxtwitter.com/user/status/123`。送信時とリンクを開く直前が対象で、既存の履歴は変更しません。置換先の可用性は保証しません。

設定画面の操作、設定保持、送信・各リンク経路、停止・再有効化を Node のモックで検証しています。実機への反映・実機での設定表示や動作確認は行っていません。

## AliExpress 対応（2026-11-04）

送信時・リンクを開く直前に、HTTP / HTTPS の `aliexpress.com`・`aliexpress.us`・`aliexpress.ru` とそのサブドメインにある `/item/数字.html`（末尾 `/` も可）の `?` 以降を削除します。AliExpressの清掃設定は初期オンで、fxtwitter のオン／オフには影響されません。ドメインや商品IDは変更しません。

例: `https://ja.aliexpress.com/item/1005001234567890.html?spm=example&aff_fcid=example` → `https://ja.aliexpress.com/item/1005001234567890.html`。SKU・色・サイズ等の選択を含むクエリも削除されるため、購入前に選択内容を確認してください。

`a.aliexpress.com` と `s.click.aliexpress.com` のリンク、検索・キャンペーン・転送・認証ページ、その他の形式やドメインは変更しません。短縮URLの展開通信も追加しません。商品ページへ直接到達するリンクを清掃する機能であり、短縮リンクの紹介情報の除去やアフィリエイトの完全遮断はできません。

調査では [Alibaba公式の紹介リンク生成API資料](https://developer.alibaba.com/docs/doc.htm?articleId=45804&docType=2&treeId=674) に、商品等の元URLとは別の `s.click.aliexpress.com/e/...` 形式の紹介リンクが記載されていることを確認しました。この形式のパスだけから商品IDを特定できるとは判断せず、そのまま保持します。商品ページの形式は [AliExpress USの商品URL](https://www.aliexpress.us/item/3256811742924446.html) でも確認しましたが、自動アクセスでは検証ページとなり、実商品の表示確認はできていません。

Nodeのモックで、対象ホスト・商品パス・類似ドメイン除外・短縮／検索／転送リンク保持・複数リンク・送信・リンクを開く各経路・停止／再有効化を確認しています。実機への反映と実際の商品ページでの動作確認は未実施です。

## サイト別のオン／オフ

設定画面で「Xのリンクを清掃」「Amazonのリンクを清掃」「Instagramのリンクを清掃」「AliExpressの商品リンクを清掃」を個別に変更できます。各サイトは初期オンで、オフのサイトは送信時・リンクを開く直前とも元のURLを保持します。保存操作や再起動は不要です。既存設定は保持し、未設定の項目だけ初期値を追加します。

「Xをfxtwitterに置き換える」は初期オフです。Xの清掃をオフにすると置換も停止し、このスイッチは操作不可になります。置換設定自体は保持し、Xの清掃を再度オンにすると保存済みの置換設定に従います。

全16通りのサイト設定で送信と各リンク経路をモック検証し、設定の即時反映・保存値の保持・再起動後の動作・X無効時の置換停止も確認しています。
