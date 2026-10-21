/* ===== カード検索エンジン（マイポケカ） =====
   - 文字の正規化（全角半角・大小・ひらがなカタカナ・空白・記号）
   - カード番号の解析（217 / 217/187 / ２１７ / #217 / SV8a-217 / 001/SV-P）
   - レアリティ指定の抽出（「ブラッキー SAR」「ブラッキーexSAR」）
   - 略称辞書（ブイズ など）
   - 軽微な入力ミス（編集距離）
   - 完全一致 > 前方一致 > 部分一致 > ゆるい一致 > もしかして の順に並べる
*/
(function (root) {
  const RARITIES = ['MUR','SAR','CHR','CSR','SSR','ACE','BWR','RRR','UR','HR','SR','AR','RR','PR','TR','MA','K','S','A','R','U','C'];
  const RARITY_SET = new Set(RARITIES.map(r => r.toLowerCase()));

  // よく使われる略称・まとめ呼び（正規化後のキー → 名前の候補）
  const ALIASES = {
    'ブイズ': ['イーブイ','シャワーズ','サンダース','ブースター','エーフィ','ブラッキー','リーフィア','グレイシア','ニンフィア'],
    'ハカセ': ['博士の研究'],
    'ハカケン': ['博士の研究'],
    'ハカセノケンキユウ': ['博士の研究'],
    'ボスシレイ': ['ボスの指令'],
    'ボスシ': ['ボスの指令'],
    'ナンジャ': ['ナンジャモ'],
    'リザ': ['リザードン'],
    'ピカ': ['ピカチュウ']
  };

  const SMALL = { 'ァ':'ア','ィ':'イ','ゥ':'ウ','ェ':'エ','ォ':'オ','ッ':'ツ','ャ':'ヤ','ュ':'ユ','ョ':'ヨ','ヮ':'ワ','ヵ':'カ','ヶ':'ケ' };

  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 96))
      .replace(/[\s\u3000]+/g, '')
      .replace(/[‐‑‒–—―−ｰ~〜]/g, 'ー')
      .replace(/[・･.,、。'"’”“!?！？()（）\[\]「」『』]/g, '');
  }
  // ゆるい形：長音・小さい文字・ハイフンの違いを無視
  function loose(s) {
    return norm(s).replace(/[ー\-_/]/g, '').replace(/[ァィゥェォッャュョヮヵヶ]/g, c => SMALL[c] || c);
  }
  function numKey(s) {
    // "017/187" → {num:17, den:"187", raw:"017/187"}
    const t = String(s || '').normalize('NFKC').trim();
    const m = t.match(/^#?0*(\d+)\s*(?:\/\s*(.+))?$/);
    if (!m) return { num: null, den: null, raw: norm(t) };
    return { num: parseInt(m[1], 10), den: m[2] ? norm(m[2]) : null, raw: norm(t) };
  }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = cur[0];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function buildIndex(cards) {
    return cards.map(c => {
      const nk = numKey(c.card_number);
      return {
        c,
        n: norm(c.card_name),
        l: loose(c.card_name),
        set: norm((c.set_name || '') + ' ' + (c.set_id || '')),
        setId: norm(c.set_id || ''),
        num: nk.num, den: nk.den, numRaw: nk.raw,
        rar: norm(c.rarity || ''),
        year: (c.release_date || '').slice(0, 4),
        date: c.release_date || ''
      };
    });
  }

  // 検索語を「名前部分」「番号」「レアリティ」「セットコード」に分解する
  function parseQuery(q, setIds) {
    const raw = String(q || '').normalize('NFKC').trim();
    const parts = raw.split(/[\s\u3000]+/).filter(Boolean);
    const out = { name: '', nums: [], rarity: null, setId: null };
    const nameParts = [];
    for (let p of parts) {
      const np = norm(p);
      // セットコード付き番号 例: sv8a-217, SV8a217
      const sm = np.match(/^([a-z]+\d+[a-z]*)[ー-]?(\d{1,3})$/);
      if (sm && setIds.has(sm[1])) { out.setId = sm[1]; out.nums.push({ num: parseInt(sm[2], 10), den: null }); continue; }
      if (setIds.has(np)) { out.setId = np; continue; }
      if (/^#?\d{1,3}(\/\S+)?$/.test(p.normalize('NFKC'))) { const k = numKey(p); out.nums.push({ num: k.num, den: k.den }); continue; }
      if (RARITY_SET.has(np) && (np.length >= 2 || parts.length > 1)) { out.rarity = np; continue; }
      nameParts.push(p);
    }
    let name = norm(nameParts.join(''));
    // 末尾にレアリティが付いている：「ブラッキーexsar」
    if (!out.rarity && name.length > 2) {
      for (const r of RARITIES) {
        const rl = r.toLowerCase();
        if (rl.length < 2 || !name.endsWith(rl)) continue;
        const pre = name.slice(0, -rl.length);
        if (pre.length >= 2 && (/[^a-z0-9]$/.test(pre) || /(ex|v|gx|vmax|vstar)$/.test(pre))) {
          out.rarity = rl; name = name.slice(0, -rl.length); break;
        }
      }
    }
    out.name = name;
    return out;
  }

  function search(index, query, opts) {
    opts = opts || {};
    const setIds = opts._setIds || new Set(index.map(x => x.setId).filter(Boolean));
    const pq = parseQuery(query, setIds);
    const rarity = (opts.rarity ? norm(opts.rarity) : null) || pq.rarity;
    const setFilter = opts.setId ? norm(opts.setId) : pq.setId;
    const year = opts.year || '';
    const qn = pq.name, ql = loose(pq.name);
    const aliasNames = (ALIASES[qn] || ALIASES[ql] || []).map(norm);

    const pass = x => (!rarity || x.rar === rarity)
      && (!setFilter || x.setId === setFilter)
      && (!year || x.year === year)
      && (!pq.nums.length || pq.nums.some(k => k.num === x.num && (!k.den || k.den === x.den)));

    const hits = [];
    const empty = !qn && !pq.nums.length && !rarity && !setFilter && !year;
    if (empty) return { results: [], parsed: pq, fuzzy: false, rarity, setFilter };

    for (const x of index) {
      if (!pass(x)) continue;
      let s = 0;
      if (!qn) s = 700;
      else if (x.n === qn) s = 1000;
      else if (x.n.startsWith(qn)) s = 850 - Math.min(100, x.n.length - qn.length);
      else if (aliasNames.some(a => x.n.startsWith(a))) s = 760;
      else if (x.n.includes(qn)) s = 650;
      else if (ql.length >= 2 && x.l.startsWith(ql)) s = 560;
      else if (ql.length >= 2 && x.l.includes(ql)) s = 520;
      else if (qn.length >= 2 && x.set.includes(qn)) s = 350;
      if (s) hits.push({ x, s, fuzzy: false });
    }

    let fuzzy = false;
    if (!hits.some(h => h.s >= 500) && ql.length >= 4) {
      const max = ql.length >= 7 ? 2 : 1;
      const seen = new Set(hits.map(h => h.x));
      for (const x of index) {
        if (seen.has(x) || !pass(x)) continue;
        const target = x.l.length > ql.length ? x.l.slice(0, ql.length) : x.l;
        const d = Math.min(lev(ql, x.l, max), lev(ql, target, max));
        if (d <= max) { hits.push({ x, s: 300 - d * 60, fuzzy: true }); fuzzy = true; }
      }
    }

    hits.sort((a, b) => b.s - a.s
      || (b.x.date > a.x.date ? 1 : b.x.date < a.x.date ? -1 : 0)
      || (a.x.setId < b.x.setId ? -1 : a.x.setId > b.x.setId ? 1 : 0)
      || ((a.x.num || 0) - (b.x.num || 0)));
    return { results: hits.map(h => ({ card: h.x.c, score: h.s, fuzzy: h.fuzzy })), parsed: pq, fuzzy, rarity, setFilter };
  }

  // 入力途中の候補（名前の重複をまとめる）
  function suggest(index, query, limit) {
    const qn = norm(query); if (!qn) return [];
    const seen = new Map();
    for (const x of index) {
      if (x.n.startsWith(qn) || (qn.length >= 2 && x.n.includes(qn))) {
        const k = x.c.card_name;
        const sc = x.n === qn ? 3 : x.n.startsWith(qn) ? 2 : 1;
        const cur = seen.get(k);
        if (!cur) seen.set(k, { name: k, count: 1, sc }); else cur.count++;
      }
    }
    return [...seen.values()].sort((a, b) => b.sc - a.sc || a.name.length - b.name.length).slice(0, limit || 6);
  }

  const api = { norm, loose, numKey, lev, buildIndex, parseQuery, search, suggest, RARITIES, ALIASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CardSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
