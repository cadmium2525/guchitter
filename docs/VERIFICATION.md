# 検証記録

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

投稿モーダル・タイムラインタブ変更後の画面。日記のある画像には架空のテスト日記を使い、初期データとしてアプリに登録されるものではない。

- [初回表示](screenshots/first-open.png)
- [デスクトップ](screenshots/timeline-desktop.png)
- [スマートフォン幅](screenshots/timeline-mobile.png)
- [スマートフォン幅の投稿モーダル](screenshots/composer-mobile.png)

画像添付、画像変換、暗号化バックアップ、復元、バックアップリマインダーは未実装であり、今回の検証対象には含まない。
