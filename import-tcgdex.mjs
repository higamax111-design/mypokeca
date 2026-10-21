// =========================================================
// TCGdex（MITライセンス）から日本版カードを取り込むプログラム
// - アプリの検索用ファイル data/cards-ja.json を作る
// - SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY があればデータベースにも保存する
// - 2回目以降は、前回取得済みのカードの詳細取得を省略する（差分取得）
// 実行: node import-tcgdex.mjs
// =========================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CS = require(path.join(ROOT, 'search.js'));
const API = 'https://api.tcgdex.net/v2/ja';

// TCGdex のレアリティ表記 → アプリで使う略号（取得元の表記は rarity_raw に残す）
const RARITY_MAP = {
  'common': 'C', 'uncommon': 'U', 'rare': 'R', 'rare holo': 'R', 'holo rare': 'R',
  'double rare': 'RR', 'triple rare': 'RRR', 'ultra rare': 'SR', 'super rare': 'SR',
  'illustration rare': 'AR', 'art rare': 'AR', 'special illustration rare': 'SAR', 'special art rare': 'SAR',
  'hyper rare': 'UR', 'secret rare': 'UR', 'shiny rare': 'S', 'shiny ultra rare': 'SSR', 'shiny super rare': 'SSR',
  'ace spec rare': 'ACE', 'radiant rare': 'K', 'amazing rare': 'A', 'character rare': 'CHR', 'character super rare': 'CSR',
  'mega hyper rare': 'MUR', 'black white rare': 'BWR', 'promo': 'PR', 'prism rare': 'PR', 'none': ''
};
const CODES = new Set(CS.RARITIES);
function mapRarity(raw) {
  if (!raw) return { code: '', mapped: true };
  const t = String(raw).normalize('NFKC').trim();
  if (CODES.has(t.toUpperCase())) return { code: t.toUpperCase(), mapped: true };
  const k = t.toLowerCase();
  return k in RARITY_MAP ? { code: RARITY_MAP[k], mapped: true } : { code: t, mapped: false };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(fetchImpl, url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'mypokeca-importer' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries) throw new Error(url + ' : ' + e.message);
      await sleep(800 * i);
    }
  }
}
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const validDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);

export async function run({ fetchImpl = fetch, outDir = path.join(ROOT, 'data'), reportPath = path.join(ROOT, 'data', 'import-report.md'), env = process.env, delayMs = 120, log = console.log } = {}) {
  const started = new Date();
  const outFile = path.join(outDir, 'cards-ja.json');
  // 前回のデータ（差分取得用）
  const prev = new Map();
  if (fs.existsSync(outFile)) {
    try { const old = JSON.parse(fs.readFileSync(outFile, 'utf8')); for (const r of old.cards) prev.set(r[0], r); } catch { /* 壊れていれば全件取り直す */ }
  }

  const setsBrief = await getJson(fetchImpl, API + '/sets');
  if (!Array.isArray(setsBrief) || !setsBrief.length) throw new Error('セット一覧を取得できませんでした');
  log(`セット ${setsBrief.length}件`);

  const sets = {}; const cards = []; const problems = []; const unmapped = new Map();
  let detailFetched = 0, detailReused = 0;

  for (const sb of setsBrief) {
    const set = await getJson(fetchImpl, API + '/sets/' + encodeURIComponent(sb.id));
    await sleep(delayMs);
    if (!set) { problems.push(`セット ${sb.id} の詳細が取得できない`); continue; }
    const official = set.cardCount && set.cardCount.official;  // 印刷されている総数だけを使う
    sets[set.id] = [set.name || sb.name || set.id, validDate(set.releaseDate) || '', official || null];
    const list = Array.isArray(set.cards) ? set.cards : [];
    if (!list.length) problems.push(`セット ${set.id}（${set.name}）にカードが0枚`);

    const rows = await pool(list, 4, async (cb) => {
      const id = 'tcgdex:ja:' + cb.id;
      const old = prev.get(id);
      let rarityRaw = old ? old[6] : null;
      if (!old || old[6] == null) {
        const full = await getJson(fetchImpl, API + '/cards/' + encodeURIComponent(cb.id)).catch(e => { problems.push(e.message); return null; });
        await sleep(delayMs);
        detailFetched++;
        rarityRaw = full && full.rarity != null ? String(full.rarity) : (full ? '' : null);
      } else detailReused++;
      const r = mapRarity(rarityRaw);
      if (!r.mapped) unmapped.set(rarityRaw, (unmapped.get(rarityRaw) || 0) + 1);
      const localId = String(cb.localId ?? '');
      const number = localId && official && /^\d+$/.test(localId) ? `${localId.padStart(String(official).length, '0')}/${official}` : localId;
      // [card_id, 名前, 番号, セットID, レアリティ, 仕様, 取得元のレアリティ表記, 取得元ID]
      return [id, cb.name || '', number, set.id, r.code, '', rarityRaw, cb.id];
    });
    for (const r of rows) if (r[1]) cards.push(r);
    log(`  ${set.id} ${set.name}: ${rows.length}枚`);
  }

  // 同じ card_id の重複を除く
  const uniq = [...new Map(cards.map(r => [r[0], r])).values()];
  fs.mkdirSync(outDir, { recursive: true });
  const payload = { v: 1, generated_at: started.toISOString(), source: 'TCGdex (https://tcgdex.dev) MIT License', sets, cards: uniq };
  fs.writeFileSync(outFile, JSON.stringify(payload));

  // データベースへ保存（キーがあるときだけ）
  let dbNote = 'データベース保存：スキップ（キー未設定）';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const base = env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
    const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
    const post = async (table, conflict, rows) => {
      for (let i = 0; i < rows.length; i += 500) {
        const res = await fetchImpl(`${base}${table}?on_conflict=${conflict}`, { method: 'POST', headers, body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!res.ok) throw new Error(`${table} 保存失敗 HTTP ${res.status} ${await res.text()}`);
      }
    };
    const now = started.toISOString();
    await post('card_sets', 'set_id', Object.entries(sets).map(([id, [name, date, count]]) => ({ set_id: id, set_name: name, release_date: date || null, card_count: count, source_name: 'TCGdex', last_updated: now })));
    await post('cards', 'card_id', uniq.map(r => ({ card_id: r[0], card_name: r[1], card_number: r[2], local_id: String(r[7]).split('-').pop(), set_id: r[3], set_name: sets[r[3]][0], rarity: r[4], rarity_raw: r[6], release_date: sets[r[3]][1] || null, card_variant: r[5] || null, image_url: null, source_name: 'TCGdex', source_card_id: r[7], name_norm: CS.norm(r[1]), last_updated: now })));
    dbNote = `データベース保存：セット ${Object.keys(sets).length}件・カード ${uniq.length}件`;
  }

  const noRarity = uniq.filter(r => !r[4]).length;
  const report = [
    `# カードデータ取り込み結果`, ``,
    `- 実行日時：${started.toISOString()}`,
    `- セット：${Object.keys(sets).length}件`,
    `- カード：${uniq.length}枚（詳細を新しく取得 ${detailFetched}・前回分を再利用 ${detailReused}）`,
    `- レアリティ未取得：${noRarity}枚`,
    `- ${dbNote}`, ``,
    `## 略号に変換できなかったレアリティ表記`,
    unmapped.size ? [...unmapped].map(([k, n]) => `- 「${k}」：${n}枚`).join('\n') : '- なし', ``,
    `## 問題（最大100件）`,
    problems.length ? problems.slice(0, 100).map(p => '- ' + p).join('\n') : '- なし', ``
  ].join('\n');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  log(report);
  return { sets: Object.keys(sets).length, cards: uniq.length, noRarity, unmapped: [...unmapped.keys()], problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(e => { console.error('取り込みに失敗しました:', e.message); process.exit(1); });
}
