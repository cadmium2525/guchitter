# 検証記録

## 画像投稿・暗号化バックアップ

2026-10-20 の変更。ランキングの紹介バナーを削除し、画像投稿、端末内WebP変換、暗号化した完全バックアップ、プレビュー付きの追加復元、保存確認とリマインダーを実装した。アプリは v0.2.0、IndexedDB は v2。v1 の既存投稿は内容を維持して移行する。

| 検証 | 結果 |
| --- | --- |
| TypeScript 型チェック、本番ビルド、Service Worker 生成 | PASS |
| 基本テスト | 80 件 PASS |
| Chrome デスクトップ・Android 相当、WebKit / iPhone 相当 | E2E 計 33 件 PASS（1.3 分）。すべて `/guchitter/` サブパスで実行 |
| 画像の変換・形式フォールバック・入力検証 | 基本テスト PASS |
| v1 移行、画像付き作成・編集・削除、保存失敗時の全体取り消し | 基本テスト PASS |
| AES-GCM の認証・KDF・形式・バージョン・タグ・画像参照と SHA-256 の検証 | 基本テスト PASS |
| 誤パスワード・改ざん・不正日時・巨大データ・作成や保存の失敗 | 基本テスト PASS。失敗時に既存データを変更しない |
| 同じバックアップの再復元、競合コピー、元投稿と復元コピーが共存するスナップショット | 基本テスト PASS。独立した記録を欠落させず、同じ復元を繰り返しても増殖させない |
| パスワードの処理後消去、共有キャンセル、保存確認、明示的な追加復元 | UI 基本テスト PASS |
| 画像の縮小・拡大・再読み込み・オフライン表示・編集削除 | E2E PASS。投稿と添付画像の削除も確認 |
| 暗号化ファイルのダウンロード、別の保存領域への画像付き復元、再復元、既存データの保持 | E2E PASS。誤パスワードと確認前の非書き込みも確認 |
| iPhone Safari / Android Chrome 実機、iPhone のネイティブ共有・保存先確認、大容量処理の最大メモリ | NOT RUN |

Windows 版 Playwright WebKit の一時コンテキストでは、単純な native Blob でも IndexedDB 保存が `UnknownError` になった。新しい通常プロファイルでは画像の保存・再読み込みが成功したため、画像・バックアップの E2E は毎回新しい通常プロファイルを使う。復元先も別の新規プロファイルとし、短い `test-results` 配下で隔離して終了後に削除する。製品の保存形式は変更していない。これらは実機 Safari の確認を意味しない。

バックアップ作成は投稿と画像の一貫した読み取り、暗号化、生成ファイルの再復号・検証まで確認する。ダウンロード開始や共有ダイアログの完了を OS 上の保存成功とは扱わず、利用者の「保存できた」で保存確認日時を記録する。処理上限と端末メモリの制約は [設計書](ARCHITECTURE.md) に記載した。配備状況は [Actions](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) で確認する。

[画像投稿の画面](screenshots/photo-timeline-mobile.png) と [復元確認の画面](screenshots/backup-restore-mobile.png) を目視確認した。画像・日記は架空のテストデータである。

## タグの重複表示の解消

2026-10-20 に検証。投稿カードの本文からタグを隠し、色付きのタグボタンだけを表示する。タグのみの行と空になる本文欄も表示しない。IndexedDB の原文・タグ・スキーマは維持し、編集フォームと検索には原文を使う。

- 型チェック、基本テスト 37 件、本番ビルド・Service Worker 生成：PASS。
- Chrome デスクトップ、Android 相当、WebKit / iPhone 相当：`/guchitter/` で E2E 計 27 件 PASS。
- 行内・別行のタグ非表示、タグのみの投稿、色付きタグの絞り込み、原文保存・編集・再読み込み：E2E PASS。
- 全角＃・Unicode タグ、改行・空白の扱い：基本テスト PASS。スマートフォン幅とデスクトップ幅の画像も目視確認した。
- [スマートフォン幅のタグ表示](screenshots/tags-single-display-mobile.png)。架空のテスト日記を使用している。
- iPhone Safari / Android Chrome 実機：NOT RUN。配備状況は [Actions](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) で確認する。

## カウンターアイコンの変更

2026-10-20 に検証。投稿カード、投稿前、累計イライラのカウンターを 💢 に変更した。ロゴの炎は維持し、ランキングの説明文を表示に合わせた。保存データや加算処理は変更していない。

- TypeScript 型チェック、基本テスト 35 件、本番ビルド・Service Worker 生成：PASS。
- 投稿・連打・再読み込み後の保存、投稿モーダルの下書きと怒り値の保持：既存 E2E の対象 2 シナリオを Chrome デスクトップ、Android 相当、WebKit / iPhone 相当で実行し、計 6 件 PASS。`/guchitter/` サブパスを使用した。
- 投稿カード、入力フォーム、累計カウンターの表示：生成したスクリーンショットを目視確認した。
- iPhone Safari / Android Chrome 実機：NOT RUN。配備状況は [Actions](https://github.com/cadmium2525/guchitter/actions/workflows/deploy.yml) で確認する。

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

初回実装時点では画像添付、画像変換、暗号化バックアップ、復元、バックアップリマインダーは未実装だったため、その時点の検証には含めていない。後続変更の結果とは区別する。
