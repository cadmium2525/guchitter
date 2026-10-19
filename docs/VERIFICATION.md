# 検証記録

## タグ履歴・投稿カード表示の変更

2026-10-19 の変更。投稿カードの「端末に保存済み」チェックと更新表示を削除し、投稿フォームの ＃ ボタンから使用回数順のタグ履歴を開く。履歴は現在の保存済み投稿から正規化済みタグを 1 投稿につき 1 回集計し、全件を表示する。選択時は本文のカーソル位置へ挿入し、入力済みタグの重複選択を防ぐ。手入力で新しいタグを追加でき、固定の例示タグは廃止する。IndexedDB の専用テーブル・スキーマ変更・データ移行はない。炎アイコンは今回変更しない。

| 検証 | 結果 |
| --- | --- |
| TypeScript 型チェック | PASS |
| Vitest 基本テスト | 35 件 PASS |
| 本番ビルド / Service Worker 生成 | PASS |
| Chrome デスクトップ・Android 相当、WebKit / iPhone 相当の E2E | 合計 24 件 PASS（51.7 秒）。すべて `/guchitter/` サブパスで実行 |
| タグの使用回数順・正規化・投稿内重複の集計 | 基本テスト PASS |
| 保存済みタグ一覧・カーソル挿入・重複選択防止・絞り込み・開閉 | E2E PASS |
| 履歴の再読み込み・オフライン表示 | E2E PASS |
| 新規タグ入力ボタン | E2E PASS。空の履歴から ＃ を入力し、本文へフォーカスを戻す |
| 編集・削除による履歴更新 | ソースレビュー済み。`liveQuery` の保存済み投稿から `getTagUsage` で再集計する。投稿本文・タグの編集と削除は E2E PASS。変更後の履歴への反映を直接見る E2E は未実施 |
| 投稿カードの「端末に保存済み」非表示 | E2E PASS |
| 投稿カードの更新表示の非表示 | ソースレビュー済み |
| 投稿カード・タグ履歴の画面の目視確認 | エミュレーション PASS。WebKit 390 × 664 の表示でモーダル内をスクロールし、タグ一覧と新規タグ入力操作へ届くことを確認 |
| iPhone Safari / Android Chrome 実機 | NOT RUN |
| GitHub Pages への配備 | ローカル検証の対象外。[Actions](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) で結果を確認する |

今回の結果は上の合計件数に含まれ、以下は過去の変更時点の記録である。実機のキーボード・スクロール・明暗テーマ・フォーカス・オフライン確認は [DEVICE-TESTS.md](DEVICE-TESTS.md) に追加した。Chrome・WebKit のエミュレーションは実機確認を意味しない。

## 投稿モーダル・タイムラインタブの変更

2026-10-19 に検証。歓迎バナーとヘッダーの「この端末だけ」表示を削除し、投稿をモーダルに移し、タイムラインへ「新しい順」「ランダム」のタブを追加した。IndexedDB のスキーマ変更・データ移行はない。

| 検証 | 結果 |
| --- | --- |
| TypeScript 型チェック | PASS |
| Vitest 基本テスト | 29 件 PASS（既存 22 件＋並べ替え 7 件） |
| 本番ビルド / Service Worker 生成 | PASS |
| Chrome デスクトップ・Android 相当、WebKit / iPhone 相当 | E2E 合計 21 件 PASS。すべて `/guchitter/` サブパスで実行 |
| モーダル開閉・自動フォーカス・Escape | E2E PASS |
| 閉じた本文・怒り値の下書き保持、保存成功後の初期化と新しい順への復帰 | E2E PASS |
| ランダムの全投稿表示・炎加算時の順序保持 | E2E PASS |
| シードによる並べ直し・編集時の順序保持 | 基本テスト PASS |
| 編集・削除・検索・ランキング・オフライン・manifest | E2E PASS |
| 新規投稿の保存失敗時のモーダル・下書き保持 | コードレビュー済み。DB 保存エラーの基本テスト PASS。ブラウザーでの障害注入は未実施 |
| iPhone Safari / Android Chrome 実機 | NOT RUN |

今回の結果は上の合計件数に含まれる。Chrome・WebKit のエミュレーションは実機確認を意味しない。実機のキーボード・読み上げ・safe area を含む未実施項目は [DEVICE-TESTS.md](DEVICE-TESTS.md) に記録している。GitHub Pages の配備状況は [Actions](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) で確認する。

## 初回実装

実施日：2026-10-19。ローカル Windows / Node.js 24.12.0 で検証した。

| 検証 | 結果 |
| --- | --- |
| TypeScript 型チェック | PASS |
| Vitest 基本テスト | 22 件 PASS |
| 本番ビルド / Service Worker 生成 | PASS |
| Chrome デスクトップ幅 | E2E 5 件 PASS |
| Chrome / Android 相当の画面・操作エミュレーション | E2E 5 件 PASS |
| WebKit / iPhone 相当の画面・操作エミュレーション | E2E 5 件 PASS |
| `/guchitter/` サブパスのオフライン動作・manifest | Chrome / WebKit 合計 4 件 PASS |
| iPhone Safari / ホーム画面 PWA 実機 | NOT RUN |
| Android Chrome / インストール済み PWA 実機 | NOT RUN |
| GitHub Pages への配備 | ローカル検証の対象外。[配備状況は Actions で確認](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) |

Chrome は端末に導入済みの Google Chrome 155.0.8059.40、WebKit は Playwright 配布版 27.2 を利用した。エミュレーションは実機での確認を意味しない。実機手順は [DEVICE-TESTS.md](DEVICE-TESTS.md) にある。

基本テストは任意精度の怒り値、タグ正規化、DB の再接続後の永続化、複数接続からの同時加算、編集との競合、保存エラーを確認した。E2E は投稿・10 回の炎タップ・再読み込み、全文／タグ検索、順位、編集、削除のキャンセルと確定、テーマ保持、横方向のはみ出しを確認した。

オフライン検証では本番アプリの Service Worker が有効になった後に通信を切り、再読み込み、新規投稿、炎の加算、タブ終了後の再起動、検索を行った。外部オリジンへの HTTP リクエストおよび同一オリジンを含むアップロード用 HTTP メソッドは検出されなかった。

初期読み込み中の入力保護、保存中のフォーム操作無効化を実装した。Windows の既存ビルド出力の削除時に発生したネイティブビルダーの終了は、プロジェクトの `dist` のみを Node で削除する [ビルドスクリプト](../scripts/build.mjs) で回避している。

## 再実行

```powershell
npm run check
npm test
npm run build
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.playwright-browsers"
# 導入済み Chrome を使う場合のみ指定。省略時は Playwright Chromium を利用。
$env:PLAYWRIGHT_CHROMIUM_CHANNEL = 'chrome'
# 既定の 4173 が使用中の場合のみ指定。
$env:PLAYWRIGHT_PORT = '4187'
npm run test:e2e
```

初めて実行する環境では、README の手順でテストブラウザーを導入する。サブパスで全 E2E を確認するには次のように実行する。

```powershell
$env:VITE_BASE_PATH = '/guchitter/'
npm run test:e2e
Remove-Item Env:VITE_BASE_PATH
```

## スクリーンショット

タグ履歴・投稿カード表示の変更後の画面を含む。タグ履歴の画像はスクロール後のモバイル表示範囲を記録している。日記のある画像には架空のテスト日記を使い、初期データとしてアプリに登録されるものではない。

- [初回表示](screenshots/first-open.png)
- [デスクトップ](screenshots/timeline-desktop.png)
- [スマートフォン幅](screenshots/timeline-mobile.png)
- [スマートフォン幅の投稿モーダル](screenshots/composer-mobile.png)
- [スマートフォン幅のタグ履歴](screenshots/tag-picker-mobile.png)

画像添付、画像変換、暗号化バックアップ、復元、バックアップリマインダーは未実装であり、今回の検証対象には含まない。
