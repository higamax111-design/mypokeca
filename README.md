# マイポケカ（非公式）

日本版ポケモンカードの検索・欲しいカード・購入記録・コレクション・資産管理アプリ。

## ファイルの役割（フォルダを使わず、すべて一番上に置く形です）
- `index.html` … アプリ画面（GitHub Pages で公開）
- `search.js` … 検索エンジン（取り込みプログラムと共通）
- `import-tcgdex.mjs` … TCGdex からカードを取り込むプログラム
- `search.test.js` / `import.test.mjs` … 自動テスト
- `schema.sql` … データベースの設計図（Supabase で実行）
- `app.js` / `style.css` / `shell.html` / `testcards.js` / `build.py` … index.html の元になる部品
- `import-cards.yml` … 毎日の自動取り込み設定（GitHub 上では `.github/workflows/import-cards.yml` に置く）
- `data/` … 取り込みで自動的に作られる（cards-ja.json と import-report.md）
- `THIRD_PARTY_NOTICE.md` … データ出典

## 設定に使う秘密の値
GitHub の Settings → Secrets and variables → Actions に登録する。
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` … 絶対に公開しない（アプリ画面のファイルには書かない）
