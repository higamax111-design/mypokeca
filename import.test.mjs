// TCGdex の応答をまねた偽データで取り込みプログラムを確認する（ネット接続なし）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { run } from './import-tcgdex.mjs';
const D = {
  '/sets': [{ id: 'SV8a', name: 'テラスタルフェスex' }, { id: 'SVP', name: 'プロモカード' }, { id: 'EMPTY', name: '空のセット' }],
  '/sets/SV8a': { id: 'SV8a', name: 'テラスタルフェスex', releaseDate: '2024-12-06', cardCount: { official: 187, total: 237 },
    cards: [{ id: 'SV8a-1', localId: '1', name: 'テストA' }, { id: 'SV8a-217', localId: '217', name: 'テストB' }, { id: 'SV8a-300', localId: '300', name: 'テストC' }] },
  '/sets/SVP': { id: 'SVP', name: 'プロモカード', releaseDate: '2023-01-01', cardCount: { total: 2 }, cards: [{ id: 'SVP-001', localId: '001', name: 'テストD' }, { id: 'SVP-002', localId: '002', name: 'テストE' }] },
  '/sets/EMPTY': { id: 'EMPTY', name: '空のセット', cards: [] },
  '/cards/SV8a-1': { rarity: 'Common' }, '/cards/SV8a-217': { rarity: 'Special illustration rare' }, '/cards/SV8a-300': { rarity: 'なぞのレア' },
  '/cards/SVP-001': { rarity: 'None' }
  // SVP-002 は 404 を返す
};
let calls = 0; const posts = [];
const fake = async (url, opt) => {
  calls++;
  if (opt && opt.method === 'POST') { posts.push({ url, n: JSON.parse(opt.body).length }); return { ok: true, status: 201, text: async () => '' }; }
  const p = url.replace('https://api.tcgdex.net/v2/ja', '');
  if (!(p in D)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => D[p] };
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpk-'));
const opts = { fetchImpl: fake, outDir: tmp, reportPath: path.join(tmp, 'r.md'), delayMs: 0, log: () => {} };
const r1 = await run({ ...opts, env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } });
const out = JSON.parse(fs.readFileSync(path.join(tmp, 'cards-ja.json'), 'utf8'));
const ok = (l, c) => { console.log((c ? '合格 ' : '不合格 ') + l); if (!c) process.exitCode = 1; };
const byId = Object.fromEntries(out.cards.map(c => [c[0], c]));
ok('カード5枚', out.cards.length === 5);
ok('番号の0埋め 001/187', byId['tcgdex:ja:SV8a-1'][2] === '001/187');
ok('番号 217/187', byId['tcgdex:ja:SV8a-217'][2] === '217/187');
ok('SAR に変換', byId['tcgdex:ja:SV8a-217'][4] === 'SAR');
ok('未知の表記はそのまま残し報告', byId['tcgdex:ja:SV8a-300'][4] === 'なぞのレア' && r1.unmapped.includes('なぞのレア'));
ok('総数不明のプロモは番号そのまま', byId['tcgdex:ja:SVP-001'][2] === '001');
ok('詳細404はレアリティ未取得として残る', byId['tcgdex:ja:SVP-002'][6] === null);
ok('空セットを報告', r1.problems.some(p => p.includes('EMPTY')));
ok('DB保存 セットとカード', posts.length === 2 && posts[1].n === 5);
const c1 = calls; calls = 0;
await run({ ...opts, env: {} });
ok(`2回目は差分取得（通信 ${c1}回 → ${calls}回）`, calls < c1 && calls === 4 + 1);
console.log(fs.readFileSync(path.join(tmp, 'r.md'), 'utf8'));
