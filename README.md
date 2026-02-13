# Perplexity Chat Exporter

Perplexity の対話ログを Chrome / Edge 拡張（Manifest V3）でエクスポートするツールです。

- 単体エクスポート: `JSON` / `MD` を選択して保存
- 一括エクスポート: `JSON` / `MD` を選択し、`ZIP圧縮あり / なし` を選択して保存
- MD は Obsidian で読みやすい形式（user 発言をコールアウト）

外部送信はせず、ローカルのダウンロードに保存します。

## 現在の主な機能
- 単体対話のダウンロード（JSON / MD）
- 複数スレッドの一括ダウンロード
  - 形式: JSON または MD
  - 圧縮: ZIP あり / なし
- メッセージに `turnIndex` を付与（1始まり）
- `timestamp` は取得できる場合のみ付与（取得不可時は `null`）
- ファイル名は安全な文字へ自動変換（OS予約名などを回避）

## セットアップ
1. このリポジトリをローカルに配置
2. Chrome: `chrome://extensions` / Edge: `edge://extensions` を開く
3. 開発者モードを ON
4. 「パッケージ化されていない拡張機能を読み込む」で `extension/` を選択

## 使い方

### 単体エクスポート
1. Perplexity の対象スレッドを開く
2. 拡張ポップアップを開く
3. `現在の対話を JSON` または `現在の対話を MD` を押す

保存先はブラウザの既定ダウンロード先（通常は Downloads）です。

### 一括エクスポート
1. Perplexity の履歴一覧やサイドバーなど、スレッドリンクが見える画面を開く
2. 拡張ポップアップを開く
3. 一括エクスポートの設定を選ぶ
   - 形式: `JSON` / `MD`
   - 圧縮: `圧縮する（ZIP）` チェック ON/OFF
4. `複数スレッドをダウンロード` を押す

### 一括出力の仕様
- 圧縮 ON: `perplexity-bulk-<format>-<timestamp>.zip`
  - 各スレッドのファイル（選択形式のみ）
  - `summary.json`（成功/失敗件数・失敗理由）
- 圧縮 OFF: 各スレッドを個別ファイルで連続ダウンロード
  - 併せて `summary.json` もダウンロード

## 出力フォーマット

### JSON
- 会話構造を保持した機械可読形式
- 各メッセージに `role`, `text`, `timestamp`, `turnIndex`

### Markdown
- 人間が読みやすい整形
- `user` は Obsidian 向けコールアウトで出力
  - `> [!question] User`
- `assistant` は見出しブロックで出力

## サンプル出力（架空データ）

以下は動作イメージ用の架空チャットです。

### JSON サンプル
```json
{
  "title": "架空サンプル: 週末の作業計画",
  "url": "https://www.perplexity.ai/search/sample-thread",
  "exportedAt": "2026-02-13T15:00:00.000Z",
  "messages": [
    {
      "role": "user",
      "text": "週末にWebサイトを1ページ作りたい。まず何から始める？",
      "timestamp": null,
      "turnIndex": 1
    },
    {
      "role": "assistant",
      "text": "目的と掲載情報を先に決めるのが最短です。次にワイヤーを作ってから実装しましょう。",
      "timestamp": null,
      "turnIndex": 2
    },
    {
      "role": "user",
      "text": "1日で終わる最小構成を教えて。",
      "timestamp": null,
      "turnIndex": 3
    },
    {
      "role": "assistant",
      "text": "ヒーロー、実績3件、お問い合わせ導線の3セクションに絞ると現実的です。",
      "timestamp": null,
      "turnIndex": 4
    }
  ]
}
```

### Markdown サンプル
```md
# 架空サンプル: 週末の作業計画

- URL: https://www.perplexity.ai/search/sample-thread
- ExportedAt: 2026-02-13T15:00:00.000Z

> [!question] User
> - turnIndex: 1
>
> 週末にWebサイトを1ページ作りたい。まず何から始める？

## assistant
- turnIndex: 2

目的と掲載情報を先に決めるのが最短です。次にワイヤーを作ってから実装しましょう。

> [!question] User
> - turnIndex: 3
>
> 1日で終わる最小構成を教えて。

## assistant
- turnIndex: 4

ヒーロー、実績3件、お問い合わせ導線の3セクションに絞ると現実的です。
```

## ダウンロード先と互換性
- ダウンロード先パスはユーザー環境ごとに異なります（OS / ブラウザ設定依存）
- この拡張は絶対パスを使わず、相対ファイル名で保存します
- `chrome.downloads.download` を使用しており、Chrome / Edge（Chromium系）で同様に動作します

## エラー時の確認ポイント
- `Perplexityページを開いたタブで実行してください。`
  - Perplexity 以外のタブで実行している
- `スレッドURLを見つけられませんでした。`
  - 履歴リンクが表示されていない画面で一括を実行している
- `すべてのスレッド抽出に失敗しました。`
  - ログイン状態切れ、または UI 変更により抽出失敗

## 既知の制限
- Perplexity の UI 変更により抽出ロジックが影響を受ける場合がある
- `timestamp` はページ上で取得できない場合がある（`null`）
- 一括の非圧縮ダウンロードではファイル数が多いと通知が多くなる

## ディレクトリ構成
- `extension/manifest.json`: 拡張機能設定
- `extension/src/popup.html`: ポップアップUI
- `extension/src/popup.js`: UIイベント処理
- `extension/src/content.js`: ページから会話データ抽出
- `extension/src/background.js`: エクスポート制御・ダウンロード処理
