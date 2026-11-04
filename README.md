# Kettu Plugins

Kettu / Vendetta 向けの、ことばとリンクを扱うプラグイン。

## プラグイン

| | 機能 | ドキュメント |
| --- | --- | --- |
| **ことば Translator** | メッセージの自動翻訳、API 切替、翻訳キャッシュ | [導入・使い方](kotoba-translator/README.md) |
| **Clean Social Links** | Instagram・X・Amazon のリンクからクエリを削除、任意でXをfxtwitterへ置換 | [導入・使い方](clean-social-links/README.md) |

それぞれ単独で動作します。実行時の npm パッケージ依存はありません。

## インストール

Kettu のプラグイン追加画面に、各プラグインの配信 URL を入力してください。URL の末尾には `/` が必要です。

| プラグイン | インストール URL |
| --- | --- |
| ことば Translator | https://porarrirr.github.io/kettu-plugins/kotoba-translator/ |
| Clean Social Links | https://porarrirr.github.io/kettu-plugins/clean-social-links/ |

Discord の内部 API を利用するため、アプリの更新で動作しなくなる場合があります。実機での確認範囲は各プラグインの README に記載しています。

## 開発

Node.js 22 以上を使用します。今後の編集・ビルド・配布は、このリポジトリで行います。

```sh
npm run setup
npm run check
```

| ディレクトリ | 内容 |
| --- | --- |
| `kotoba-translator/` | ことば Translator |
| `clean-social-links/` | Clean Social Links |

各ディレクトリに `src/`、`test/`、ビルドスクリプト、配布用の `index.js` と `manifest.json` をまとめています。ソースを変更したら `npm run check` を実行し、生成された配布ファイルも一緒にコミットしてください。CI でテストと生成物の一致を確認します。

## 配布

GitHub Pages で `main` ブランチのルートから配信しています。各プラグインの `index.js` と `manifest.json` が配布ファイルです。

更新時は `npm run check` で生成・検証し、ソースと配布ファイルを一緒にコミットして `main` へプッシュしてください。GitHub Pages の反映後もインストール URL は同じです。

このフォルダは独立した Git リポジトリです。公開用構成での実機検証範囲は、各プラグインの README を確認してください。

## プライバシー

Translator は翻訳対象を設定した外部 API へ送信します。API キー・設定・原文と訳文のキャッシュ・統計は端末のプラグインストレージに保存されます。送信先と削除方法は[詳しい説明](kotoba-translator/README.md)を確認してください。

Clean Social Links はプラグイン自身による外部通信やリンク本文の保存を行いません。fxtwitter 置換設定のオン／オフだけを端末に保存します。API キー、端末設定、ログ、バックアップをリポジトリに含めないでください。

## ライセンス

[OSL-3.0](LICENSE)。元リポジトリのライセンスを継承しています。
