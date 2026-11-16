# Tsunagu（つなぐ）

PC と Android をシームレスにつなぐ連携システム。Windows の「スマートフォン連携」のように、ブラウザからスマホの通知・メッセージ・通話・写真・ファイル・クリップボードを扱えます。UI は Material 3 Expressive + ダイナミックカラーで、PC の大画面では複数列のダッシュボードと一覧・詳細の 2 ペイン、スマホ／タブレットでも幅に応じたレイアウトに切り替わります。

- **Web（PC 側）**: https://tsunagu-link.vercel.app
- **Android APK**: [Releases](https://github.com/orokichi/tsunagu-link/releases/latest)

## 機能
| 機能 | 内容 |
|---|---|
| ペアリング | PC の QR をアプリでスキャン、またはコード入力（PC 側で許可）。連携は初回のみで、以後は同じ Wi-Fi で直接接続（LAN）に自動接続し、外出先などではクラウド経由にフォールバック |
| 通知 | ミラー表示・デスクトップ通知・返信・アクション・消去 |
| メッセージ | SMS スレッド閲覧・送信・受信通知 |
| 通話 | 通話履歴・ダイヤルパッドから発信・着信通知・拒否 |
| 写真と動画 | 最近のメディアをサムネイルで閲覧、選んで PC に保存 |
| ファイル共有 | PC→スマホ（ドラッグ&ドロップ、ダウンロード/Tsunagu に保存）、スマホ→PC（共有メニュー「PC に送る」/アプリ内） |
| クイック設定 | PC から自動回転・着信モード（着信音/バイブ/ミュート）・サイレントモード・メディア音量を操作（要「システム設定の変更」「サイレントモードへのアクセス」） |
| 設定 | 接続方法（自動／クラウドのみ）の切り替え、ローカル接続先（スマホの IP とポート）の手動指定と接続テスト |
| スマホ → PC | 接続中の PC（種類・ブラウザ・OS・バッテリー・オンライン）を表示し、PC でリンクを開く・テキスト送信・PC に通知・PC を鳴らす |
| クリップボード | 双方向同期。PC はタブ復帰時、スマホはアプリ表示時・クイック設定タイル・テキスト共有 |
| その他 | メディア操作と音量、スマホを鳴らす（マナーモードでも）、リンクを開く、電池・バッテリーセーバー・回線・容量・着信モード |

## 構成
- 通信: WebRTC DataChannel（端末間 P2P・暗号化）。同一 LAN ではスマホ側の認証付きシグナリング受け口（PNA 対応 HTTP）で直接接続し、トラフィックはインターネットを経由しない。接続先はスマホが知らせる IP を自動で使い、設定タブで IP とポートを手動指定もできる。LAN が使えない環境では PeerJS クラウド経由にフォールバック（シグナリングのみクラウド）
- `/` Web: Vite + React + TypeScript、@material/material-color-utilities
- `/android` Android: Kotlin + Jetpack Compose（Material 3 Expressive: MaterialExpressiveTheme / MotionScheme.expressive / MaterialShapes / LoadingIndicator / WavyProgress）。接続はフォアグラウンドサービス内のヘッドレス WebView（PeerJS）で維持し、通知リスナー・SMS・通話・MediaStore・MediaSession などネイティブ API とブリッジ

## ビルドと公開
- Web: `main` への push で Vercel が自動デプロイ
- APK: `android/` の変更で GitHub Actions が固定キー（暗号化して保管、復号パスワードはリポジトリ Secret `TS_KEY_PASS`）で署名し Releases に公開
