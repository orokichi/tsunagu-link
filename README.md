# Tsunagu（つなぐ）

PC と Android をシームレスにつなぐ連携システム。Windows の「スマートフォン連携」のように、ブラウザからスマホの通知・メッセージ・通話・写真・ファイル・クリップボードを扱えます。UI は Material 3 Expressive + ダイナミックカラー。

- **Web（PC 側）**: https://tsunagu-link.vercel.app
- **Android APK**: [Releases](https://github.com/orokichi/tsunagu-link/releases/latest)

## 機能
| 機能 | 内容 |
|---|---|
| ペアリング | PC の QR をアプリでスキャン、またはコード入力（PC 側で許可）。以後は自動再接続 |
| 通知 | ミラー表示・デスクトップ通知・返信・アクション・消去 |
| メッセージ | SMS スレッド閲覧・送信・受信通知 |
| 通話 | 通話履歴・ダイヤルパッドから発信・着信通知・拒否 |
| 写真と動画 | 最近のメディアをサムネイルで閲覧、選んで PC に保存 |
| ファイル共有 | PC→スマホ（ドラッグ&ドロップ、ダウンロード/Tsunagu に保存）、スマホ→PC（共有メニュー「PC に送る」/アプリ内） |
| クリップボード | 双方向同期。PC はタブ復帰時、スマホはアプリ表示時・クイック設定タイル・テキスト共有 |
| その他 | メディア操作、スマホを鳴らす（マナーモードでも）、リンクを開く、電池・回線・容量・着信モード |

## 構成
- 通信: WebRTC DataChannel（PeerJS、端末間 P2P・暗号化。シグナリングのみ PeerJS クラウド）
- `/` Web: Vite + React + TypeScript、@material/material-color-utilities
- `/android` Android: Kotlin + Jetpack Compose（Material 3 Expressive: MaterialExpressiveTheme / MotionScheme.expressive / MaterialShapes / LoadingIndicator / WavyProgress）。接続はフォアグラウンドサービス内のヘッドレス WebView（PeerJS）で維持し、通知リスナー・SMS・通話・MediaStore・MediaSession などネイティブ API とブリッジ

## ビルドと公開
- Web: `main` への push で Vercel が自動デプロイ
- APK: `android/` の変更で GitHub Actions が固定キー（暗号化して保管、復号パスワードはリポジトリ Secret `TS_KEY_PASS`）で署名し Releases に公開
