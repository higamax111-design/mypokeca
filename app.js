/* ===== マイポケカ フェーズ1 アプリ本体 ===== */
(function () {
'use strict';
const CS = window.CardSearch;
const LS_DATA = 'mpk-data-v2', LS_MASTER = 'mpk-master-v1', LS_TEST = 'mpk-test-on', LS_DIRTY = 'mpk-dirty-v1', LS_SEEDED = 'mpk-cloud-seeded';
const TABLES = ['manualCards', 'wishes', 'purchases', 'prices', 'cardMeta', 'albums'];
const CONDITIONS = ['美品', '小傷あり', '傷あり', '鑑定品'];
const PRICE_KINDS = { market: '参考市場価格', shop_sell: '店舗販売価格', shop_buy: '店舗買取価格' };
const TOP_RAR = new Set(['SAR', 'UR', 'MUR', 'HR', 'SSR', 'CSR', 'BWR', 'CHR', 'SR', 'ACE']);

/* ---------- 小道具 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString('ja-JP');
const sYen = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + yen(Math.abs(n));
const today = () => new Date().toLocaleDateString('sv-SE');
const nowIso = () => new Date().toISOString();
const uid = p => (p || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const docId = s => String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 180);
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).normalize('NFKC').replace(/[,，円¥\s]/g, '')); return Number.isFinite(n) && n >= 0 ? n : NaN; };
function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', 2300); }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

/* ---------- データ ---------- */
function emptyState() { const s = {}; TABLES.forEach(t => s[t] = []); return s; }
let S = Object.assign(emptyState(), lsGet(LS_DATA, {}));
TABLES.forEach(t => { if (!Array.isArray(S[t])) S[t] = []; });
let MASTER = lsGet(LS_MASTER, { sources: [], cards: [] });
let BUNDLED = { cards: [], generated_at: '', source: '', sets: 0 };  // サイトに同梱したカードデータ（TCGdex）
let testOn = lsGet(LS_TEST, false);
let dirty = lsGet(LS_DIRTY, { up: {}, del: {} });  // クラウド未反映の変更

let cardMap = new Map(), index = [], setList = [], rarList = [], yearList = [];
function rebuildIndex() {
  const all = [];
  BUNDLED.cards.forEach(c => all.push(c));
  MASTER.cards.forEach(c => all.push(c));
  if (testOn) (window.TEST_CARDS || []).forEach(c => all.push(c));
  S.manualCards.filter(c => !c.linked_to).forEach(c => all.push(c));
  cardMap = new Map();
  all.forEach(c => cardMap.set(c.card_id, c));
  S.manualCards.forEach(c => { if (!cardMap.has(c.card_id)) cardMap.set(c.card_id, c); });
  index = CS.buildIndex(all);
  index._setIds = new Set(index.map(x => x.setId).filter(Boolean));
  const sets = new Map();
  all.forEach(c => { if (c.set_id || c.set_name) sets.set(c.set_id || c.set_name, { id: c.set_id || c.set_name, name: c.set_name || c.set_id, date: c.release_date || '' }); });
  setList = [...sets.values()].sort((a, b) => (b.date > a.date ? 1 : -1));
  rarList = [...new Set(all.map(c => c.rarity).filter(Boolean))].sort((a, b) => CS.RARITIES.indexOf(a) - CS.RARITIES.indexOf(b));
  yearList = [...new Set(all.map(c => (c.release_date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
}
const card = id => cardMap.get(id) || { card_id: id, card_name: '（不明なカード）', missing: true };

function saveLocal() {
  if (!lsSet(LS_DATA, S)) toast('端末への保存に失敗しました。容量を確認してください');
  lsSet(LS_DIRTY, dirty);
}
function put(table, rec) {
  rec.updated_at = nowIso();
  const arr = S[table], i = arr.findIndex(x => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  dirty.up[table + '/' + rec.id] = 1; delete dirty.del[table + '/' + rec.id];
  saveLocal(); cloudWrite(table, rec);
}
function del(table, id) {
  S[table] = S[table].filter(x => x.id !== id);
  dirty.del[table + '/' + id] = 1; delete dirty.up[table + '/' + id];
  saveLocal(); cloudDelete(table, id);
}

/* ---------- クラウド保存（Supabase／claude.ai のデータベース） ---------- */
const CFG = window.MPK_CONFIG || {};
let cloud = null, syncState = 'local', chain = Promise.resolve(), pendingOps = 0;
let sb = null, sbUser = null;
const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const intOrNull = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const blank = v => (v == null || v === '' ? null : v);
// アプリ内の形 ⇔ Supabase のテーブルの形
const MAP = {
  manualCards: { table: 'manual_cards',
    to: r => ({ id: r.id, card_name: r.card_name, card_number: blank(r.card_number), set_name: blank(r.set_name), rarity: blank(r.rarity), release_date: blank(r.release_date), card_variant: blank(r.card_variant), linked_to: blank(r.linked_to), created_at: r.created_at }),
    from: d => ({ id: d.id, card_id: d.id, card_name: d.card_name, card_number: d.card_number || '', set_name: d.set_name || '', rarity: d.rarity || '', release_date: d.release_date || '', card_variant: d.card_variant || '', linked_to: d.linked_to || null, is_manual: true, source_name: '手動登録', created_at: d.created_at, updated_at: d.updated_at }) },
  wishes: { table: 'wishes',
    to: r => ({ id: r.id, card_id: r.card_id, qty: Math.max(1, intOrNull(r.qty) || 1), target_yen: intOrNull(r.target), priority: intOrNull(r.priority) || 2, memo: blank(r.memo), share_with_friends: !!r.share, created_at: r.created_at }),
    from: d => ({ id: d.id, card_id: d.card_id, qty: d.qty, target: d.target_yen, priority: d.priority, memo: d.memo || '', share: !!d.share_with_friends, created_at: d.created_at, updated_at: d.updated_at }) },
  purchases: { table: 'purchases',
    to: r => ({ id: r.id, card_id: r.card_id, price_yen: intOrNull(r.price) || 0, qty: Math.max(1, intOrNull(r.qty) || 1), shipping_yen: intOrNull(r.shipping) || 0, fee_yen: intOrNull(r.fee) || 0, purchased_on: ymd(r.date), store: blank(r.store), condition: blank(r.cond), grader: blank(r.grader), grade: blank(r.grade), memo: blank(r.memo), created_at: r.created_at }),
    from: d => ({ id: d.id, card_id: d.card_id, price: d.price_yen, qty: d.qty, shipping: d.shipping_yen, fee: d.fee_yen, date: d.purchased_on || '', store: d.store || '', cond: d.condition || '', grader: d.grader || '', grade: d.grade || '', memo: d.memo || '', created_at: d.created_at, updated_at: d.updated_at }) },
  prices: { table: 'user_prices',
    to: r => ({ id: r.id, card_id: r.card_id, price_kind: r.kind, condition: r.cond || '指定なし', grader: blank(r.grader), grade: blank(r.grade), price_yen: intOrNull(r.price) || 0, source_note: blank(r.source), recorded_at: r.recorded_at }),
    from: d => ({ id: d.id, card_id: d.card_id, kind: d.price_kind, cond: d.condition, grader: d.grader || '', grade: d.grade || '', price: d.price_yen, source: d.source_note || '手動入力', recorded_at: d.recorded_at, updated_at: d.updated_at }) },
  cardMeta: { table: 'card_meta', conflict: 'user_id,id',
    to: r => ({ id: r.id, card_id: r.card_id, favorite: !!r.fav, location: blank(r.location), memo: blank(r.memo), album_ids: r.albums || [] }),
    from: d => ({ id: d.id, card_id: d.card_id, fav: d.favorite, location: d.location || '', memo: d.memo || '', albums: d.album_ids || [], updated_at: d.updated_at }) },
  albums: { table: 'albums',
    to: r => ({ id: r.id, name: r.name, created_at: r.created_at }),
    from: d => ({ id: d.id, name: d.name, created_at: d.created_at, updated_at: d.updated_at }) }
};

function setSync(st, msg) {
  syncState = st;
  const el = $('#sync');
  if (!el) return;
  el.className = 'sync ' + (st === 'ok' ? 'ok' : st === 'error' ? 'err' : '');
  el.textContent = st === 'ok' ? '☁ 保存済み' : st === 'saving' ? '☁ 保存中…' : st === 'error' ? '⚠ 未保存あり' : st === 'connecting' ? '☁ 接続中…' : st === 'login' ? '🔑 ログイン' : '📱 この端末のみ';
  if (msg) el.title = msg;
}
function queue(fn, key, kind) {
  pendingOps++; setSync('saving');
  chain = chain.then(fn).then(() => {
    if (kind === 'up') delete dirty.up[key]; else delete dirty.del[key];
    lsSet(LS_DIRTY, dirty);
  }).catch(e => {
    console.warn('cloud', e); setSync('error', String(e && (e.code || e.message) || e));
    if (e && e.code === 'quota_exceeded') toast('クラウドの保存容量の上限に達しました。データは端末には保存されています');
  }).finally(() => { pendingOps--; if (!pendingOps) setSync(Object.keys(dirty.up).length || Object.keys(dirty.del).length ? 'error' : 'ok'); });
}
function cloudWrite(t, rec) {
  if (!cloud) return;
  queue(() => cloud.write(t, JSON.parse(JSON.stringify(rec))), t + '/' + rec.id, 'up');
}
function cloudDelete(t, id) {
  if (!cloud) return;
  queue(() => cloud.remove(t, id), t + '/' + id, 'del');
}

// クラウドのデータと端末のデータを合わせる（クラウドを正として、未送信の変更だけ上乗せ）
function mergeRemote(remote, seedKey) {
  const remoteCount = TABLES.reduce((a, t) => a + remote[t].length, 0);
  const seeded = lsGet(seedKey, false);
  lsSet(seedKey, true);
  if (!remoteCount && !seeded) {
    TABLES.forEach(t => S[t].forEach(r => cloudWrite(t, r)));
    if (!pendingOps) setSync('ok');
    return;
  }
  const merged = emptyState();
  for (const t of TABLES) {
    const m = new Map(remote[t].map(r => [r.id, r]));
    S[t].forEach(r => { if (dirty.up[t + '/' + r.id]) m.set(r.id, r); });
    Object.keys(dirty.del).forEach(k => { const [tt, ...rest] = k.split('/'); if (tt === t) m.delete(rest.join('/')); });
    merged[t] = [...m.values()];
  }
  S = merged; saveLocal(); rebuildIndex();
  Object.keys(dirty.up).forEach(k => { const [t, ...rest] = k.split('/'); const r = (S[t] || []).find(x => x.id === rest.join('/')); if (r) cloudWrite(t, r); });
  Object.keys(dirty.del).forEach(k => { const [t, ...rest] = k.split('/'); cloudDelete(t, rest.join('/')); });
  if (!pendingOps) setSync('ok');
  render();
}

// claude.ai 上で開いたとき
async function connectClaude() {
  setSync('connecting');
  try {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !user) return setSync('local');
    const id = await user.id();
    if (!id) return setSync('local');
    const base = db.doc('data/users/' + id + '/app');
    const remote = {};
    for (const t of TABLES) {
      const snap = await base.collection(t).get();
      remote[t] = snap.docs.filter(d => d.exists).map(d => JSON.parse(JSON.stringify(d.data())));
    }
    cloud = { kind: 'claude', label: 'claude.ai のデータベース',
      write: (t, rec) => base.collection(t).doc(docId(rec.id)).set(rec),
      remove: (t, id) => base.collection(t).doc(docId(id)).delete() };
    mergeRemote(remote, LS_SEEDED);
  } catch (e) { console.warn(e); cloud = null; setSync('error', String(e && (e.code || e.message) || e)); }
}

// 公開サイト（GitHub Pages）で開いたとき：Supabase
async function sbCall(p) { const { data, error } = await p; if (error) throw error; return data; }
async function connectSupabase() {
  if (!sbUser) { cloud = null; setSync('login'); return; }
  setSync('connecting');
  try {
    const remote = {};
    for (const t of TABLES) {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = await sbCall(sb.from(MAP[t].table).select('*').range(from, from + 999));
        rows.push(...page);
        if (page.length < 1000) break;
      }
      remote[t] = rows.map(MAP[t].from);
    }
    const uidNow = sbUser.id;
    cloud = { kind: 'supabase', label: 'Supabase（' + (sbUser.email || 'ログイン中') + '）',
      write: (t, rec) => sbCall(sb.from(MAP[t].table).upsert(Object.assign({ user_id: uidNow }, MAP[t].to(rec)), { onConflict: MAP[t].conflict || 'id' })),
      remove: (t, id) => sbCall(sb.from(MAP[t].table).delete().eq('id', id).eq('user_id', uidNow)) };
    mergeRemote(remote, LS_SEEDED + ':' + uidNow);
  } catch (e) { console.warn(e); cloud = null; setSync('error', String(e && (e.message || e.code) || e)); toast('クラウドに接続できませんでした。端末には保存されています'); }
}
function initSupabase() {
  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase || typeof window.supabase.createClient !== 'function') return false;
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  setSync('login');
  sb.auth.onAuthStateChange((ev, session) => {
    const u = session && session.user ? session.user : null;
    const changed = (u && u.id) !== (sbUser && sbUser.id);
    sbUser = u;
    if (changed) { if (u) { connectSupabase(); if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname); } else { cloud = null; setSync('login'); } if (tab === 'settings') renderSettings(); }
  });
  return true;
}
async function sendLoginMail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('メールアドレスを確認してください');
  try {
    await sbCall(sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
    toast('ログイン用のメールを送りました');
    const n = $('#loginNote'); if (n) n.textContent = 'メールに届いたリンクを、このブラウザで開いてください。届かないときは迷惑メールも確認してください。';
  } catch (e) { toast('送信できませんでした：' + (e.message || e)); }
}
function connectCloud() {
  if (window.claude && typeof window.claude.use === 'function') return connectClaude();
  if (initSupabase()) return;
  setSync('local');
}

/* ---------- 集計 ---------- */
function ownedQty(cardId) { return S.purchases.filter(p => p.card_id === cardId).reduce((a, p) => a + (Number(p.qty) || 1), 0); }
function lotCost(p) { return (Number(p.price) || 0) * (Number(p.qty) || 1) + (Number(p.shipping) || 0) + (Number(p.fee) || 0); }
function condKey(cond, grader, grade) { return cond === '鑑定品' ? '鑑定品:' + (grader || '') + (grade || '') : (cond || '指定なし'); }
function latestPrice(cardId, kind, key) {
  const list = S.prices.filter(x => x.card_id === cardId && x.kind === kind && condKey(x.cond, x.grader, x.grade) === key)
    .sort((a, b) => (b.recorded_at || '').localeCompare(a.recorded_at || ''));
  return list[0] || null;
}
// 状態に合った参考市場価格。鑑定品は同じ鑑定・グレードのみ。未鑑定は同じ状態→「指定なし」の順。
function refFor(cardId, cond, grader, grade) {
  const k = condKey(cond, grader, grade);
  let p = latestPrice(cardId, 'market', k);
  if (!p && cond !== '鑑定品') p = latestPrice(cardId, 'market', '指定なし');
  return p;
}
function wishOf(cardId) { return S.wishes.find(w => w.card_id === cardId); }
function metaOf(cardId) { return S.cardMeta.find(m => m.card_id === cardId); }
function assets() {
  let total = 0, valued = 0, valuedCost = 0, unvaluedLots = 0, count = 0;
  const byMonth = {}, byStore = {}, byCard = {};
  for (const p of S.purchases) {
    const c = lotCost(p), q = Number(p.qty) || 1;
    total += c; count += q;
    const m = (p.date || '').slice(0, 7) || '日付なし'; byMonth[m] = (byMonth[m] || 0) + c;
    const st = p.store || '店舗未記録'; byStore[st] = (byStore[st] || 0) + c;
    const bc = byCard[p.card_id] || (byCard[p.card_id] = { cost: 0, qty: 0, value: 0, vcost: 0, vq: 0 });
    bc.cost += c; bc.qty += q;
    const r = refFor(p.card_id, p.cond, p.grader, p.grade);
    if (r) { valued += r.price * q; valuedCost += c; bc.value += r.price * q; bc.vcost += c; bc.vq += q; } else unvaluedLots++;
  }
  return { total, valued, valuedCost, diff: valued - valuedCost, rate: valuedCost ? (valued - valuedCost) / valuedCost * 100 : null, unvaluedLots, count, byMonth, byStore, byCard };
}

/* ---------- 表示部品 ---------- */
function tierColor(c) {
  if (c.is_manual) return 'var(--t-manual)';
  const r = (c.rarity || '').toUpperCase();
  if (r === 'PR') return 'var(--t-promo)';
  if (TOP_RAR.has(r)) return 'var(--t-top)';
  if (/R/.test(r) || r === 'K') return 'var(--t-mid)';
  return 'var(--t-low)';
}
function tile(c, lg) {
  const n = String(c.card_number || '').split('/')[0] || '—';
  return `<div class="tile${lg ? ' lg' : ''}" style="--tc:${tierColor(c)}" aria-hidden="true"><span>${esc((c.set_id || '').slice(0, 6) || (c.is_manual ? '手動' : ''))}</span><b>${esc(c.rarity || '?')}</b><span class="num">${esc(n.slice(0, 7))}</span></div>`;
}
function cardLine(c) {
  const bits = [c.set_name || '収録商品未設定', c.card_number || '番号未設定', (c.release_date || '').slice(0, 4)].filter(Boolean);
  let tags = '';
  if (c.is_manual) tags += ' <span class="chip muted">手動登録</span>';
  if (c.is_test) tags += ' <span class="chip muted">テスト</span>';
  if (c.card_variant) tags += ' <span class="chip muted">' + esc(c.card_variant) + '</span>';
  return esc(bits.join(' / ')) + tags;
}
function rarChip(c) { return c.rarity ? `<span class="chip" style="color:${tierColor(c)}">${esc(c.rarity)}</span>` : ''; }

/* ---------- 画面切り替え ---------- */
let tab = 'home';
const VIEWS = ['home', 'wish', 'search', 'collection', 'assets', 'settings'];
function go(t) {
  tab = t;
  VIEWS.forEach(v => $('#v-' + v).classList.toggle('hide', v !== t));
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.go === t));
  render(); window.scrollTo(0, 0);
  if (t === 'search') setTimeout(() => $('#q').focus(), 50);
}
function render() {
  if (tab === 'home') renderHome();
  if (tab === 'wish') renderWish();
  if (tab === 'search') renderSearch();
  if (tab === 'collection') renderCollection();
  if (tab === 'assets') renderAssets();
  if (tab === 'settings') renderSettings();
}

/* ---------- ホーム ---------- */
function renderHome() {
  const a = assets();
  const ws = [...S.wishes].sort((x, y) => (x.priority || 2) - (y.priority || 2) || (y.created_at || '').localeCompare(x.created_at || ''));
  const open = ws.filter(w => ownedQty(w.card_id) < (w.qty || 1));
  $('#v-home').innerHTML = `
    ${MASTER.cards.length || BUNDLED.cards.length ? '' : `<div class="note">カードデータがまだ読み込まれていません。今は「手動登録」と「テスト用カード」で動きます。<button class="btn sm sub" data-act="go" data-to="settings" style="margin-left:6px">データ設定へ</button></div>`}
    <button class="shopcta" data-act="shop">
      <span class="ic" aria-hidden="true">🏷️</span>
      <span><span class="t">お店でチェック</span><br><span class="s">値札の金額を入れて、相場と目標価格を比べる</span></span>
    </button>
    <div class="box">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">探しているカード</h2><button class="btn sm line" data-act="go" data-to="wish">すべて ${S.wishes.length}件</button></div>
      ${open.length ? `<div class="pockets" style="margin-top:10px">${open.slice(0, 12).map(w => { const c = card(w.card_id); return `<button class="pocket" data-act="shop" data-card="${esc(c.card_id)}">${tile(c)}<div class="nm">${esc(c.card_name)}</div><div class="sm">${esc(c.rarity || '')} ${w.target != null ? '目標 ' + yen(w.target) : ''}</div><div class="sm">あと${(w.qty || 1) - ownedQty(w.card_id)}枚</div></button>`; }).join('')}</div>`
      : `<div class="empty">欲しいカードを登録すると、ここにすぐ出せます。<br><button class="btn sm sub" data-act="go" data-to="search" style="margin-top:8px">カードを検索する</button></div>`}
    </div>
    <div class="box">
      <h2>コレクションのいま</h2>
      <table class="sum num">
        <tr><td>所持カード</td><td>${a.count}枚</td></tr>
        <tr><td>購入総額（送料・手数料込み）</td><td>${yen(a.total)}</td></tr>
        <tr><td>参考評価額 <span class="muted small">評価できる分のみ</span></td><td>${a.valuedCost ? yen(a.valued) : '—'}</td></tr>
        <tr><td>評価差額</td><td class="${a.diff > 0 ? 'up' : a.diff < 0 ? 'down' : ''}">${a.valuedCost ? sYen(a.diff) : '—'}</td></tr>
      </table>
      ${a.unvaluedLots ? `<p class="small muted" style="margin:8px 0 0">参考価格が未設定の購入記録 ${a.unvaluedLots}件は、評価額に含めていません。</p>` : ''}
    </div>`;
}

/* ---------- 欲しいカード ---------- */
let wishSort = 'priority';
function renderWish() {
  const ws = [...S.wishes];
  ws.sort((x, y) => wishSort === 'priority' ? (x.priority || 2) - (y.priority || 2) : (y.created_at || '').localeCompare(x.created_at || ''));
  const P = { 1: '高', 2: '中', 3: '低' };
  $('#v-wish').innerHTML = `<h1 class="view">欲しいカード</h1><p class="lead">お店ではカードをタップして「お店でチェック」へ。</p>
    <div class="seg"><button class="${wishSort === 'priority' ? 'on' : ''}" data-act="wsort" data-v="priority">優先度順</button><button class="${wishSort === 'new' ? 'on' : ''}" data-act="wsort" data-v="new">登録が新しい順</button></div>
    <div class="box">${ws.length ? ws.map(w => {
      const c = card(w.card_id), have = ownedQty(w.card_id), need = Math.max(0, (w.qty || 1) - have), r = refFor(w.card_id, '指定なし');
      return `<div class="item tap" data-act="card" data-card="${esc(c.card_id)}">${tile(c)}<div class="body">
        <div class="name">${esc(c.card_name)} ${rarChip(c)}</div>
        <div class="meta">${cardLine(c)}</div>
        <div class="meta num">優先度 ${P[w.priority || 2]} ・ 目標 ${w.target != null ? yen(w.target) : '未設定'} ・ 参考相場 ${r ? yen(r.price) : '未取得'}</div>
        <div class="meta num">所持 ${have} / 希望 ${w.qty || 1}枚 ${need ? `<b style="color:var(--ink)">あと${need}枚</b>` : '<b class="up">そろいました</b>'}</div>
        ${w.memo ? `<div class="meta">📝 ${esc(w.memo)}</div>` : ''}
      </div><div class="qbtns"><button class="btn sm" data-act="shop" data-card="${esc(c.card_id)}">お店で<br>チェック</button></div></div>`;
    }).join('') : '<div class="empty">まだ登録がありません。<br>検索でカードを選んで「欲しい」を押すと追加されます。</div>'}</div>`;
}

/* ---------- 検索 ---------- */
let q = '', fRar = '', fSet = '', fYear = '', shown = 30, lastRes = null, qTimer = 0;
function searchSkeleton() {
  $('#v-search').innerHTML = `<div class="searchbar">
      <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="カード名・番号（例：ぶらっきー 217）" aria-label="カード名またはカード番号">
      <div class="sugs" id="sugs"></div>
      <div class="filters"><select class="in" id="fRar" aria-label="レアリティ"></select><select class="in" id="fSet" aria-label="収録商品"></select><select class="in" id="fYear" aria-label="発売年"></select></div>
    </div>
    <div id="srcInfo" class="count"></div>
    <div id="results"></div>`;
  const qi = $('#q');
  qi.value = q;
  qi.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { q = qi.value; shown = 30; renderResults(); }, 140); });
  ['fRar', 'fSet', 'fYear'].forEach(id => $('#' + id).addEventListener('change', e => {
    if (id === 'fRar') fRar = e.target.value; if (id === 'fSet') fSet = e.target.value; if (id === 'fYear') fYear = e.target.value; shown = 30; renderResults();
  }));
}
function renderSearch() {
  if (!$('#q')) searchSkeleton();
  $('#fRar').innerHTML = '<option value="">レア すべて</option>' + rarList.map(r => `<option ${r === fRar ? 'selected' : ''}>${esc(r)}</option>`).join('');
  $('#fSet').innerHTML = '<option value="">収録商品 すべて</option>' + setList.map(s => `<option value="${esc(s.id)}" ${s.id === fSet ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('#fYear').innerHTML = '<option value="">年 すべて</option>' + yearList.map(y => `<option ${y === fYear ? 'selected' : ''}>${esc(y)}</option>`).join('');
  const nOff = MASTER.cards.length + BUNDLED.cards.length, nTest = testOn ? (window.TEST_CARDS || []).length : 0, nMan = S.manualCards.filter(c => !c.linked_to).length;
  $('#srcInfo').innerHTML = `検索できるカード ${(nOff + nTest + nMan).toLocaleString()}枚（読み込みデータ ${nOff.toLocaleString()} ・ テスト ${nTest} ・ 手動 ${nMan}）`;
  renderResults();
}
function renderResults() {
  const box = $('#results'); if (!box) return;
  const t0 = performance.now();
  const sug = CS.suggest(index, q, 6);
  $('#sugs').innerHTML = sug.filter(s => CS.norm(s.name) !== CS.norm(q)).map(s => `<button data-act="sug" data-v="${esc(s.name)}">${esc(s.name)} <span class="muted">${s.count}</span></button>`).join('');
  const res = CS.search(index, q, { rarity: fRar, setId: fSet, year: fYear, _setIds: index._setIds });
  lastRes = res;
  const ms = Math.round(performance.now() - t0);
  const blank = !q.trim() && !fRar && !fSet && !fYear;
  if (blank) {
    box.innerHTML = `<div class="box"><div class="empty">名前の一部・カード番号・レアリティで探せます。<br><span class="small">例：「ぶらっきー」「ブラッキーex SAR」「217/187」</span></div>
      <div class="acts"><button class="btn line" data-act="manual">見つからないカードを手動登録</button></div></div>`;
    return;
  }
  const list = res.results;
  if (!list.length) {
    const fil = fRar || fSet || fYear || res.rarity || res.setFilter;
    box.innerHTML = `<div class="box"><div class="empty">「${esc(q)}」に当てはまるカードはありませんでした。</div>
      <p class="small muted">試せること：名前を短くする（例「ブラッキー」）／ ひらがなで入れる ／ 番号だけで探す（例「217」）</p>
      <div class="acts" style="flex-direction:column">${fil ? '<button class="btn sub" data-act="clearf">絞り込みを外して探し直す</button>' : ''}
      <button class="btn line" data-act="manual">このカードを手動登録する</button></div></div>`;
    return;
  }
  const page = list.slice(0, shown);
  box.innerHTML = `<div class="count num">${list.length.toLocaleString()}件 ${res.fuzzy ? '・<b>入力ミスの可能性がある候補も表示しています</b>' : ''} ・ ${ms}ms</div>
    <div class="box">${page.map(({ card: c, fuzzy }) => {
      const w = wishOf(c.card_id), have = ownedQty(c.card_id), r = refFor(c.card_id, '指定なし');
      return `<div class="item tap" data-act="card" data-card="${esc(c.card_id)}">${tile(c)}<div class="body">
        <div class="name">${esc(c.card_name)} ${rarChip(c)}${fuzzy ? ' <span class="chip muted">もしかして</span>' : ''}</div>
        <div class="meta">${cardLine(c)}</div>
        <div class="meta num">${r ? '参考相場 ' + yen(r.price) : '参考相場 未取得'}${have ? ' ・ 所持' + have : ''}${w ? ' ・ ♥欲しい' : ''}</div>
      </div><div class="qbtns"><button class="btn sm sub" data-act="wishEdit" data-card="${esc(c.card_id)}" aria-label="欲しいに追加">${w ? '♥' : '♡'} 欲しい</button><button class="btn sm line" data-act="buy" data-card="${esc(c.card_id)}">＋購入</button></div></div>`;
    }).join('')}</div>
    ${list.length > shown ? '<button class="btn line" style="width:100%" data-act="more">さらに表示</button>' : ''}
    <div class="acts"><button class="btn line" data-act="manual">見つからないカードを手動登録</button></div>`;
}

/* ---------- シート ---------- */
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#scrim').classList.add('open'); $('#sheet').classList.add('open');
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#scrim').classList.remove('open'); $('#sheet').classList.remove('open'); }
const head = (t, sub) => `<div class="sheethead"><div><h3>${esc(t)}</h3>${sub ? `<div class="small muted">${sub}</div>` : ''}</div><button class="close" data-act="close" aria-label="閉じる">×</button></div>`;
const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };

/* カード詳細 */
function sheetCard(cardId) {
  const c = card(cardId), w = wishOf(cardId), m = metaOf(cardId) || {}, have = ownedQty(cardId);
  const ps = S.purchases.filter(p => p.card_id === cardId).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const prices = S.prices.filter(p => p.card_id === cardId).sort((a, b) => (b.recorded_at || '').localeCompare(a.recorded_at || ''));
  openSheet(`${head(c.card_name, cardLine(c))}
    <div class="row" style="align-items:flex-start;margin-top:10px">${tile(c, true)}
      <dl class="kv" style="margin:0">
        <dt>レアリティ</dt><dd>${esc(c.rarity || '未設定')}</dd>
        <dt>番号</dt><dd>${esc(c.card_number || '未設定')}</dd>
        <dt>収録</dt><dd>${esc(c.set_name || '未設定')}</dd>
        <dt>発売</dt><dd>${esc(c.release_date || '不明')}</dd>
        <dt>データ元</dt><dd>${esc(c.source_name || '')}</dd>
        <dt>所持</dt><dd class="num">${have}枚</dd>
      </dl></div>
    ${c.is_manual ? `<div class="note" style="margin-top:10px">手動登録したカードです。正式なカードデータが読み込まれたら、紐付けると記録がそのまま引き継がれます。<div class="acts"><button class="btn sm sub" data-act="link" data-card="${esc(cardId)}">正式データに紐付ける</button><button class="btn sm line" data-act="manualEdit" data-card="${esc(cardId)}">登録内容を直す</button></div></div>` : ''}
    <div class="acts"><button class="btn" data-act="shop" data-card="${esc(cardId)}">お店でチェック</button><button class="btn sub" data-act="buy" data-card="${esc(cardId)}">購入を記録</button></div>
    <div class="acts"><button class="btn line" data-act="wishEdit" data-card="${esc(cardId)}">${w ? '欲しい設定を変更' : '♡ 欲しいに追加'}</button><button class="btn line" data-act="priceEdit" data-card="${esc(cardId)}">参考価格を入力</button></div>
    <div class="box" style="margin-top:14px"><h2>購入履歴</h2>${ps.length ? ps.map(p => `<div class="item"><div class="body"><div class="name num">${yen(p.price)} × ${p.qty || 1}枚 <span class="small muted">計 ${yen(lotCost(p))}</span></div>
      <div class="meta">${esc(p.date || '日付なし')} ・ ${esc(p.store || '店舗未記録')} ・ ${esc(p.cond === '鑑定品' ? (p.grader || '鑑定') + ' ' + (p.grade || '') : (p.cond || '状態未記録'))}${p.memo ? '<br>📝 ' + esc(p.memo) : ''}</div></div>
      <button class="btn sm line" data-act="buyEdit" data-id="${esc(p.id)}">編集</button></div>`).join('') : '<div class="small muted">まだありません</div>'}</div>
    <div class="box"><h2>参考価格の記録</h2>${prices.length ? prices.map(p => `<div class="item"><div class="body"><div class="name num">${yen(p.price)} <span class="chip muted">${esc(PRICE_KINDS[p.kind] || p.kind)}</span></div>
      <div class="meta">${esc(p.cond === '鑑定品' ? (p.grader || '鑑定') + ' ' + (p.grade || '') : (p.cond || '指定なし'))} ・ ${esc((p.recorded_at || '').slice(0, 10))} ・ ${esc(p.source || '手動入力')}</div></div>
      <button class="btn sm line" data-act="priceDel" data-id="${esc(p.id)}">削除</button></div>`).join('') : '<div class="small muted">参考相場はまだ取得・入力されていません。</div>'}</div>
    ${have || m.id ? `<div class="box"><h2>コレクションのメモ</h2>
      <label class="checkrow"><input type="checkbox" id="mFav" ${m.fav ? 'checked' : ''}> ★ お気に入り</label>
      <label class="f" for="mLoc">保管場所</label><input class="in" id="mLoc" value="${esc(m.location || '')}" placeholder="例：青いバインダー 3ページ">
      <label class="f" for="mMemo">メモ</label><textarea class="in" id="mMemo">${esc(m.memo || '')}</textarea>
      <label class="f">アルバム</label>${S.albums.length ? S.albums.map(al => `<label class="checkrow"><input type="checkbox" class="mAl" value="${esc(al.id)}" ${(m.albums || []).includes(al.id) ? 'checked' : ''}> ${esc(al.name)}</label>`).join('') : '<div class="small muted">コレクション画面でアルバムを作ると、ここで選べます。</div>'}
      <div class="acts"><button class="btn sub" data-act="metaSave" data-card="${esc(cardId)}">メモを保存</button></div></div>` : ''}`);
}

/* 欲しい登録 */
function sheetWish(cardId) {
  const c = card(cardId), w = wishOf(cardId) || {};
  openSheet(`${head(w.id ? '欲しい設定を変更' : '欲しいカードに追加', esc(c.card_name) + ' ' + rarChip(c))}
    <div class="grid2"><div><label class="f" for="wQty">希望枚数</label><input class="in num" id="wQty" type="number" inputmode="numeric" min="1" value="${esc(w.qty || 1)}"></div>
    <div><label class="f" for="wPri">優先度</label><select class="in" id="wPri">${[[1, '高'], [2, '中'], [3, '低']].map(([v, l]) => `<option value="${v}" ${(w.priority || 2) == v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label class="f" for="wTarget">目標購入価格（円）<span>任意</span></label><input class="in num" id="wTarget" inputmode="numeric" value="${w.target != null ? esc(w.target) : ''}" placeholder="例：27000">
    <label class="f" for="wMemo">メモ<span>任意</span></label><input class="in" id="wMemo" value="${esc(w.memo || '')}" placeholder="例：美品のみ">
    <label class="checkrow"><input type="checkbox" id="wShare" ${w.share ? 'checked' : ''}> 友達に公開する（友達機能の公開時に使われます）</label>
    <div class="acts"><button class="btn" data-act="wishSave" data-card="${esc(cardId)}">${w.id ? '変更を保存' : '欲しいに追加'}</button></div>
    ${w.id ? `<div class="acts"><button class="btn danger" data-act="wishDel" data-card="${esc(cardId)}">欲しいリストから外す</button></div>` : ''}`);
}

/* お店でチェック */
function sheetShop(cardId) {
  if (!cardId) {
    const ws = S.wishes.filter(w => ownedQty(w.card_id) < (w.qty || 1));
    openSheet(`${head('お店でチェック', 'どのカードの値札を見ていますか？')}
      ${ws.length ? `<div class="box" style="margin-top:10px">${ws.map(w => { const c = card(w.card_id); return `<div class="item tap" data-act="shop" data-card="${esc(c.card_id)}">${tile(c)}<div class="body"><div class="name">${esc(c.card_name)} ${rarChip(c)}</div><div class="meta">${cardLine(c)}</div><div class="meta num">目標 ${w.target != null ? yen(w.target) : '未設定'}</div></div></div>`; }).join('')}</div>` : '<div class="empty">欲しいカードがまだありません。</div>'}
      <div class="acts"><button class="btn line" data-act="goSearch">検索して選ぶ</button></div>`);
    return;
  }
  const c = card(cardId), w = wishOf(cardId);
  openSheet(`${head('お店でチェック', esc(c.card_name) + ' ' + rarChip(c) + '<br>' + cardLine(c))}
    <label class="f" for="sPrice">値札の金額（円）</label><input class="in num" id="sPrice" inputmode="numeric" placeholder="例：28000" style="font-size:22px;font-weight:700">
    <div class="grid2"><div><label class="f" for="sCond">状態</label><select class="in" id="sCond"><option>指定なし</option>${CONDITIONS.map(x => `<option>${x}</option>`).join('')}</select></div>
    <div><label class="f" for="sStore">お店<span>任意</span></label><input class="in" id="sStore" placeholder="店名"></div></div>
    <div id="gradeRow" class="grid2 hide"><div><label class="f" for="sGrader">鑑定機関</label><input class="in" id="sGrader" placeholder="例：PSA"></div><div><label class="f" for="sGrade">グレード</label><input class="in" id="sGrade" placeholder="例：10"></div></div>
    <div id="shopOut"></div>
    <div class="acts"><button class="btn" data-act="shopBuy" data-card="${esc(cardId)}">この金額で購入を記録</button></div>
    <p class="small muted">表示は判断材料です。参考相場は実際に売れる価格とは異なることがあります。</p>`);
  const upd = () => {
    const price = num(val('sPrice')), cond = val('sCond');
    $('#gradeRow').classList.toggle('hide', cond !== '鑑定品');
    const r = cond === '指定なし' ? latestPrice(cardId, 'market', '指定なし') : refFor(cardId, cond, val('sGrader'), val('sGrade'));
    const rows = [];
    const cmp = (label, base) => {
      if (price == null || Number.isNaN(price)) return `<li><span>${label}</span><span class="v num">${yen(base)}</span></li>`;
      const d = price - base;
      return `<li><span>${label} ${yen(base)}</span><span class="v num ${d < 0 ? 'up' : d > 0 ? 'down' : ''}">${d < 0 ? yen(-d) + ' 安い' : d > 0 ? yen(d) + ' 高い' : '同じ'}</span></li>`;
    };
    rows.push(r ? cmp(`参考相場（${esc(r.cond === '鑑定品' ? (r.grader || '') + (r.grade || '') : r.cond || '指定なし')}・${esc((r.recorded_at || '').slice(5, 10).replace('-', '/'))}）`, r.price) : '<li><span>参考相場</span><span class="v muted">未取得</span></li>');
    rows.push(w && w.target != null ? cmp('目標購入価格', w.target) : '<li><span>目標購入価格</span><span class="v muted">未設定</span></li>');
    if (w) { const need = Math.max(0, (w.qty || 1) - ownedQty(cardId)); rows.push(`<li><span>あと何枚ほしい？</span><span class="v num">${need}枚</span></li>`); }
    $('#shopOut').innerHTML = `<div class="pricetag"><div class="l">店頭価格</div><div class="p num">${price != null && !Number.isNaN(price) ? yen(price) : '¥—'}</div></div><ul class="cmp">${rows.join('')}</ul>`;
  };
  ['sPrice', 'sCond', 'sGrader', 'sGrade'].forEach(id => $('#' + id).addEventListener('input', upd));
  upd(); setTimeout(() => $('#sPrice').focus(), 250);
}

/* 購入記録 */
function sheetBuy(cardId, pid, preset) {
  const p = pid ? S.purchases.find(x => x.id === pid) : null;
  if (p) cardId = p.card_id;
  const c = card(cardId), d = Object.assign({ qty: 1, date: today(), cond: '美品' }, preset || {}, p || {});
  const hasDetail = !!(p && (p.shipping || p.fee || p.memo || p.grader));
  openSheet(`${head(p ? '購入記録を編集' : '購入を記録', esc(c.card_name) + ' ' + rarChip(c) + '<br>' + cardLine(c))}
    <label class="f" for="bPrice">1枚あたりの購入価格（円）</label><input class="in num" id="bPrice" inputmode="numeric" value="${d.price != null ? esc(d.price) : ''}" placeholder="例：28000" style="font-size:22px;font-weight:700">
    <div class="grid2"><div><label class="f" for="bQty">枚数</label><input class="in num" id="bQty" type="number" inputmode="numeric" min="1" value="${esc(d.qty)}"></div>
    <div><label class="f" for="bDate">購入日</label><input class="in" id="bDate" type="date" value="${esc(d.date)}"></div></div>
    <label class="f" for="bStore">購入店舗<span>任意</span></label><input class="in" id="bStore" value="${esc(d.store || '')}" placeholder="例：駅前のカードショップ" list="storeList">
    <datalist id="storeList">${[...new Set(S.purchases.map(x => x.store).filter(Boolean))].map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <details class="more" ${hasDetail ? 'open' : ''}><summary>くわしく記録する（送料・状態・鑑定・メモ）</summary>
      <div class="grid2"><div><label class="f" for="bShip">送料</label><input class="in num" id="bShip" inputmode="numeric" value="${d.shipping != null ? esc(d.shipping) : ''}" placeholder="0"></div>
      <div><label class="f" for="bFee">手数料</label><input class="in num" id="bFee" inputmode="numeric" value="${d.fee != null ? esc(d.fee) : ''}" placeholder="0"></div></div>
      <label class="f" for="bCond">カードの状態</label><select class="in" id="bCond">${CONDITIONS.map(x => `<option ${x === d.cond ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <div class="grid2"><div><label class="f" for="bGrader">鑑定機関</label><input class="in" id="bGrader" value="${esc(d.grader || '')}" placeholder="例：PSA"></div><div><label class="f" for="bGrade">グレード</label><input class="in" id="bGrade" value="${esc(d.grade || '')}" placeholder="例：10"></div></div>
      <label class="f" for="bMemo">メモ</label><textarea class="in" id="bMemo">${esc(d.memo || '')}</textarea>
      <p class="small muted">カード写真の登録は次の段階で追加します。</p>
    </details>
    <div class="acts"><button class="btn" data-act="buySave" data-card="${esc(cardId)}" data-id="${esc(p ? p.id : '')}">${p ? '変更を保存' : '購入を記録'}</button></div>
    ${p ? `<div class="acts"><button class="btn danger" data-act="buyDel" data-id="${esc(p.id)}">この購入記録を削除</button></div>` : ''}`);
  if (!p) setTimeout(() => $('#bPrice').focus(), 250);
}

/* 参考価格 */
function sheetPrice(cardId) {
  const c = card(cardId);
  openSheet(`${head('参考価格を入力', esc(c.card_name) + ' ' + rarChip(c))}
    <p class="small muted">自分で確認した価格を記録します。種類と状態ごとに分けて保存し、混ぜて平均はしません。評価額には「参考市場価格」だけを使います。</p>
    <div class="grid2"><div><label class="f" for="pKind">種類</label><select class="in" id="pKind">${Object.entries(PRICE_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div><label class="f" for="pCond">状態</label><select class="in" id="pCond"><option>指定なし</option>${CONDITIONS.map(x => `<option>${x}</option>`).join('')}</select></div></div>
    <div class="grid2"><div><label class="f" for="pGrader">鑑定機関</label><input class="in" id="pGrader" placeholder="鑑定品のみ"></div><div><label class="f" for="pGrade">グレード</label><input class="in" id="pGrade" placeholder="例：10"></div></div>
    <label class="f" for="pPrice">金額（円）</label><input class="in num" id="pPrice" inputmode="numeric" placeholder="例：30000">
    <label class="f" for="pSrc">確認した場所<span>任意</span></label><input class="in" id="pSrc" placeholder="例：〇〇の販売価格を見た">
    <div class="acts"><button class="btn" data-act="priceSave" data-card="${esc(cardId)}">保存する</button></div>`);
}

/* 手動登録 */
function sheetManual(cardId) {
  const m = cardId ? S.manualCards.find(x => x.card_id === cardId) : null;
  const d = m || { card_name: q || '' };
  openSheet(`${head(m ? '手動登録の内容を直す' : '見つからないカードを手動登録', '正式データとは分けて保存します。あとで紐付けできます。')}
    <label class="f" for="mName">カード名</label><input class="in" id="mName" value="${esc(d.card_name)}" placeholder="例：ブラッキーex">
    <div class="grid2"><div><label class="f" for="mNum">カード番号<span>任意</span></label><input class="in" id="mNum" value="${esc(d.card_number || '')}" placeholder="例：217/187"></div>
    <div><label class="f" for="mRar">レアリティ<span>任意</span></label><input class="in" id="mRar" value="${esc(d.rarity || '')}" placeholder="例：SAR"></div></div>
    <label class="f" for="mSet">収録商品<span>任意</span></label><input class="in" id="mSet" value="${esc(d.set_name || '')}" placeholder="例：拡張パック名">
    <div class="grid2"><div><label class="f" for="mDate">発売日・年<span>任意</span></label><input class="in" id="mDate" value="${esc(d.release_date || '')}" placeholder="例：2025"></div>
    <div><label class="f" for="mVar">仕様<span>任意</span></label><input class="in" id="mVar" value="${esc(d.card_variant || '')}" placeholder="例：ミラー・プロモ"></div></div>
    <div class="acts"><button class="btn" data-act="manualSave" data-card="${esc(m ? m.card_id : '')}">${m ? '変更を保存' : '登録する'}</button></div>`);
}

/* 紐付け */
function sheetLink(manualId, lq) {
  const mc = card(manualId);
  const res = lq ? CS.search(index, lq, { _setIds: index._setIds }).results.filter(r => !r.card.is_manual).slice(0, 30) : [];
  openSheet(`${head('正式データに紐付ける', '手動登録「' + esc(mc.card_name) + '」の記録を、選んだカードに移します。')}
    <label class="f" for="lq">正式データを検索</label><input class="in" id="lq" value="${esc(lq || mc.card_name)}">
    <div class="acts"><button class="btn sub" data-act="linkSearch" data-card="${esc(manualId)}">検索</button></div>
    <div class="box" style="margin-top:12px">${lq ? (res.length ? res.map(({ card: c }) => `<div class="item">${tile(c)}<div class="body"><div class="name">${esc(c.card_name)} ${rarChip(c)}</div><div class="meta">${cardLine(c)}</div></div><button class="btn sm" data-act="linkDo" data-from="${esc(manualId)}" data-to="${esc(c.card_id)}">これにする</button></div>`).join('') : '<div class="empty">正式データに見つかりません。データを読み込んでから試してください。</div>') : '<div class="small muted">「検索」を押すと候補が出ます。</div>'}</div>`);
}
function doLink(from, to) {
  const target = card(to);
  if (!confirm(`「${card(from).card_name}」の記録を「${target.card_name} ${target.rarity || ''} ${target.card_number || ''}」に移します。よろしいですか？`)) return;
  S.purchases.filter(p => p.card_id === from).forEach(p => put('purchases', Object.assign({}, p, { card_id: to })));
  S.prices.filter(p => p.card_id === from).forEach(p => put('prices', Object.assign({}, p, { card_id: to })));
  const wf = wishOf(from), wt = wishOf(to);
  if (wf) { if (wt) { put('wishes', Object.assign({}, wt, { qty: Math.max(wt.qty || 1, wf.qty || 1), target: wt.target != null ? wt.target : wf.target, memo: [wt.memo, wf.memo].filter(Boolean).join(' / ') })); del('wishes', wf.id); } else put('wishes', Object.assign({}, wf, { card_id: to })); }
  const mf = metaOf(from);
  if (mf && !metaOf(to)) { put('cardMeta', Object.assign({}, mf, { id: docId(to), card_id: to })); del('cardMeta', mf.id); }
  const mc = S.manualCards.find(x => x.card_id === from);
  put('manualCards', Object.assign({}, mc, { linked_to: to }));
  rebuildIndex(); closeSheet(); render(); toast('紐付けました'); sheetCard(to);
}

/* ---------- コレクション ---------- */
let colQ = '', colAlbum = '', colFav = false, colSort = 'new';
function renderCollection() {
  const ids = [...new Set(S.purchases.map(p => p.card_id))];
  const a = assets();
  let rows = ids.map(id => {
    const c = card(id), m = metaOf(id) || {}, bc = a.byCard[id];
    const last = S.purchases.filter(p => p.card_id === id).map(p => p.date || '').sort().pop() || '';
    return { c, m, bc, last };
  });
  const nq = CS.norm(colQ);
  rows = rows.filter(r => (!nq || CS.norm(r.c.card_name + r.c.card_number + r.c.set_name + r.c.rarity).includes(nq)) && (!colAlbum || (r.m.albums || []).includes(colAlbum)) && (!colFav || r.m.fav));
  rows.sort((x, y) => colSort === 'cost' ? y.bc.cost - x.bc.cost : colSort === 'name' ? x.c.card_name.localeCompare(y.c.card_name, 'ja') : y.last.localeCompare(x.last));
  $('#v-collection').innerHTML = `<h1 class="view">コレクション</h1><p class="lead">購入を記録したカードがここに入ります。最初は自分だけに表示されます。</p>
    <div class="box">
      <input class="in" id="colQ" type="search" placeholder="コレクション内を探す" value="${esc(colQ)}">
      <div class="grid2" style="margin-top:8px"><select class="in" id="colAlbum"><option value="">アルバム すべて</option>${S.albums.map(al => `<option value="${esc(al.id)}" ${al.id === colAlbum ? 'selected' : ''}>${esc(al.name)}</option>`).join('')}</select>
      <select class="in" id="colSort"><option value="new" ${colSort === 'new' ? 'selected' : ''}>最近買った順</option><option value="cost" ${colSort === 'cost' ? 'selected' : ''}>購入額が大きい順</option><option value="name" ${colSort === 'name' ? 'selected' : ''}>名前順</option></select></div>
      <label class="checkrow"><input type="checkbox" id="colFav" ${colFav ? 'checked' : ''}> ★お気に入りだけ</label>
      <div class="row wrapr" style="margin-top:4px">${S.albums.map(al => `<button class="btn sm line" data-act="albumDel" data-id="${esc(al.id)}" title="アルバムを削除">${esc(al.name)} ×</button>`).join('')}<button class="btn sm sub" data-act="albumAdd">＋アルバムを作る</button></div>
    </div>
    <div class="box">${rows.length ? rows.map(({ c, m, bc }) => `<div class="item tap" data-act="card" data-card="${esc(c.card_id)}">${tile(c)}<div class="body">
        <div class="name">${m.fav ? '★ ' : ''}${esc(c.card_name)} ${rarChip(c)}</div>
        <div class="meta">${cardLine(c)}</div>
        <div class="meta num">${bc.qty}枚 ・ 購入 ${yen(bc.cost)} ・ ${bc.vq ? '参考 ' + yen(bc.value) + (bc.vq < bc.qty ? `（${bc.vq}枚分）` : '') : '参考価格 未設定'}</div>
        ${m.location ? `<div class="meta">📦 ${esc(m.location)}</div>` : ''}
        ${(m.albums || []).length ? `<div class="meta">${m.albums.map(id => { const al = S.albums.find(x => x.id === id); return al ? `<span class="chip muted">${esc(al.name)}</span>` : ''; }).join(' ')}</div>` : ''}
      </div></div>`).join('') : `<div class="empty">${ids.length ? '条件に合うカードがありません。' : 'まだ購入記録がありません。<br>検索や「欲しいカード」から購入を記録できます。'}</div>`}</div>`;
  const ci = $('#colQ'); ci.addEventListener('input', () => { colQ = ci.value; clearTimeout(qTimer); qTimer = setTimeout(() => { renderCollection(); const n = $('#colQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); });
  $('#colAlbum').addEventListener('change', e => { colAlbum = e.target.value; renderCollection(); });
  $('#colSort').addEventListener('change', e => { colSort = e.target.value; renderCollection(); });
  $('#colFav').addEventListener('change', e => { colFav = e.target.checked; renderCollection(); });
}

/* ---------- 資産 ---------- */
function renderAssets() {
  const a = assets();
  const months = []; const d = new Date(); d.setDate(1);
  for (let i = 11; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push(x.toLocaleDateString('sv-SE').slice(0, 7)); }
  const maxM = Math.max(1, ...months.map(m => a.byMonth[m] || 0));
  const stores = Object.entries(a.byStore).sort((x, y) => y[1] - x[1]).slice(0, 8);
  const cards = Object.entries(a.byCard);
  const valuedCards = cards.filter(([, b]) => b.vq).map(([id, b]) => ({ id, d: b.value - b.vcost, r: b.vcost ? (b.value - b.vcost) / b.vcost * 100 : 0 }));
  const ups = valuedCards.filter(x => x.d > 0).sort((x, y) => y.d - x.d).slice(0, 5), downs = valuedCards.filter(x => x.d < 0).sort((x, y) => x.d - y.d).slice(0, 5);
  const topCost = cards.sort((x, y) => y[1].cost - x[1].cost).slice(0, 5);
  const rank = list => list.length ? list.map(x => { const c = card(x.id); return `<div class="item tap" data-act="card" data-card="${esc(x.id)}"><div class="body"><div class="name">${esc(c.card_name)} ${rarChip(c)}</div><div class="meta">${cardLine(c)}</div></div><div class="num ${x.d > 0 ? 'up' : 'down'}" style="font-weight:700;text-align:right">${sYen(x.d)}<br><span class="small">${x.r.toFixed(1)}%</span></div></div>`; }).join('') : '<div class="small muted">対象のカードがありません</div>';
  $('#v-assets').innerHTML = `<h1 class="view">資産</h1><p class="lead">購入額と、自分で入力した参考価格をくらべます。</p>
    <div class="box"><table class="sum num">
      <tr><td>購入総額 <span class="muted small">価格＋送料・手数料</span></td><td>${yen(a.total)}</td></tr>
      <tr><td>所持カード</td><td>${a.count}枚</td></tr>
      <tr><td>評価できるカードの取得費用</td><td>${yen(a.valuedCost)}</td></tr>
      <tr><td>参考評価額</td><td>${a.valuedCost ? yen(a.valued) : '—'}</td></tr>
      <tr><td>評価差額</td><td class="${a.diff > 0 ? 'up' : a.diff < 0 ? 'down' : ''}">${a.valuedCost ? sYen(a.diff) : '—'}</td></tr>
      <tr><td>評価変動率</td><td class="${a.diff > 0 ? 'up' : a.diff < 0 ? 'down' : ''}">${a.rate != null ? (a.rate > 0 ? '+' : '') + a.rate.toFixed(1) + '%' : '—'}</td></tr>
    </table>
    <p class="small muted" style="margin:10px 0 0">評価額と差額は、参考市場価格を入力した購入記録だけで計算しています（評価対象外：${a.unvaluedLots}件）。参考価格は実際に売れる金額とは限りません。</p></div>
    <div class="box"><h2>月別の購入額（直近12か月）</h2><div class="bars num">${months.map(m => `<div class="b" title="${m} ${yen(a.byMonth[m] || 0)}"><span>${a.byMonth[m] ? Math.round((a.byMonth[m]) / 1000) + 'k' : ''}</span><i style="height:${(a.byMonth[m] || 0) / maxM * 85}%"></i><span>${+m.slice(5)}月</span></div>`).join('')}</div></div>
    <div class="box"><h2>店舗別の購入額</h2>${stores.length ? `<table class="sum num">${stores.map(([s, v]) => `<tr><td>${esc(s)}</td><td>${yen(v)}</td></tr>`).join('')}</table>` : '<div class="small muted">まだありません</div>'}</div>
    <div class="box"><h2>購入額が大きいカード</h2>${topCost.length ? `<table class="sum num">${topCost.map(([id, b]) => `<tr data-act="card" data-card="${esc(id)}" style="cursor:pointer"><td>${esc(card(id).card_name)} <span class="muted small">${esc(card(id).rarity || '')}</span></td><td>${yen(b.cost)}</td></tr>`).join('')}</table>` : '<div class="small muted">まだありません</div>'}</div>
    <div class="box"><h2>参考価格が購入額より上</h2>${rank(ups)}</div>
    <div class="box"><h2>参考価格が購入額より下</h2>${rank(downs)}</div>
    <p class="small muted">売却の記録（売却額・手数料・実現損益）は次の段階で追加します。</p>`;
}

/* ---------- 設定・データ ---------- */
function renderSettings() {
  const counts = TABLES.map(t => `${{ manualCards: '手動カード', wishes: '欲しい', purchases: '購入', prices: '参考価格', cardMeta: 'メモ', albums: 'アルバム' }[t]} ${S[t].length}`).join(' ・ ');
  $('#v-settings').innerHTML = `<h1 class="view">データと設定</h1>
    <div class="box"><h2>保存先・アカウント</h2>
      <p class="small">${cloud ? '☁ ' + esc(cloud.label) + ' に保存しています。同じアカウントでログインすれば、別の端末でも同じデータが見られます。この端末にも控えを保存しています。' : '📱 今はこの端末のブラウザにだけ保存しています。'}</p>
      ${sb ? (sbUser ? `<div class="acts"><button class="btn line" data-act="logout">ログアウト</button></div>`
        : `<label class="f" for="loginEmail">メールアドレスでログイン<span>パスワード不要</span></label><input class="in" id="loginEmail" type="email" autocomplete="email" placeholder="you@example.com">
           <div class="acts"><button class="btn" data-act="login">ログイン用メールを送る</button></div><p class="small muted" id="loginNote">届いたメールのリンクを開くとログインできます。ログイン前に記録したデータは、初回ログイン時にクラウドへ移されます。</p>`) : ''}
      <p class="small muted num">${counts}</p></div>
    <div class="box"><h2>バックアップ</h2><p class="small muted">購入記録・欲しいカード・手動登録カードなどを1つのファイルにまとめます。</p>
      <div class="acts"><button class="btn sub" data-act="export">バックアップを書き出す</button><button class="btn line" data-act="importOpen">読み込む</button></div></div>
    <div class="box"><h2>カードデータ</h2>
      ${BUNDLED.cards.length ? `<p class="small">アプリ同梱データ：<b class="num">${BUNDLED.cards.length.toLocaleString()}枚</b>（${BUNDLED.sets}セット・${esc(BUNDLED.generated_at.slice(0, 10))}更新）<br><span class="muted">出典：${esc(BUNDLED.source)}</span></p>` : ''}
      <p class="small">手動で読み込んだデータ：<b class="num">${MASTER.cards.length.toLocaleString()}枚</b>${MASTER.sources.length ? '<br>' + MASTER.sources.map(s => `${esc(s.name)}（${esc(s.count)}枚・${esc((s.imported_at || '').slice(0, 10))}）`).join('<br>') : ''}</p>
      <p class="small muted">TCGdex の日本語データ（JSON）や、このアプリ形式のカード一覧を読み込めます。読み込んだデータはこの端末に保存されます。カード画像は利用条件の確認が取れるまで表示しません。</p>
      <div class="acts"><button class="btn sub" data-act="masterOpen">カードデータを読み込む</button>${MASTER.cards.length ? '<button class="btn line" data-act="masterClear">読み込みデータを消す</button>' : ''}</div>
      <label class="checkrow" style="margin-top:10px"><input type="checkbox" id="testOn" ${testOn ? 'checked' : ''}> 検索テスト用カード（架空の${(window.TEST_CARDS || []).length}枚）を検索に含める</label></div>
    <div class="box"><h2>このアプリについて</h2><p class="small">ポケモンカードの収集記録のための<b>非公式</b>アプリです。株式会社ポケモン等の公式サービスとは関係ありません。参考価格は判断材料であり、購入をすすめるものではありません。</p></div>
    <div class="box"><h2>データの消去</h2><p class="small muted">購入記録・欲しいカードなど、あなたのデータをすべて消します。先にバックアップをおすすめします。</p><button class="btn danger" data-act="wipe">すべてのデータを消去</button></div>`;
  $('#testOn').addEventListener('change', e => { testOn = e.target.checked; lsSet(LS_TEST, testOn); rebuildIndex(); toast(testOn ? 'テスト用カードを含めます' : 'テスト用カードを外しました'); });
}

/* 書き出し */
async function exportBackup() {
  const data = JSON.stringify({ app: 'mypokeca', schema: 2, exported_at: nowIso(), data: S }, null, 2);
  const name = 'mypokeca-backup-' + today() + '.json';
  try {
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (dl) { await dl.save({ filename: name, data: new Blob([data], { type: 'application/json' }) }); toast('バックアップを書き出しました'); return; }
  } catch (e) { if (e && e.code && e.code !== 'unavailable') { toast('保存がキャンセルされました'); return; } }
  openSheet(`${head('バックアップ', 'この端末ではファイル保存が使えないため、文字で表示します。すべてコピーしてメモ帳などに保存してください。')}
    <textarea class="in num" id="expTxt" style="min-height:260px;font-size:12px" readonly>${esc(data)}</textarea>
    <div class="acts"><button class="btn" data-act="copyExp">すべてコピー</button></div>`);
}
function importSheet(kind) {
  openSheet(`${head(kind === 'master' ? 'カードデータを読み込む' : 'バックアップを読み込む', kind === 'master' ? 'JSONファイルを選ぶか、中身を貼り付けてください。' : '今のデータは、バックアップの内容に置き換わります。')}
    <label class="f" for="impFile">ファイルを選ぶ</label><input class="in" id="impFile" type="file" accept="application/json,.json,.txt">
    <label class="f" for="impTxt">または貼り付け</label><textarea class="in" id="impTxt" style="min-height:140px;font-size:12px" placeholder="{ ... }"></textarea>
    <div class="acts"><button class="btn" data-act="${kind === 'master' ? 'masterDo' : 'importDo'}">読み込む</button></div>
    ${kind === 'master' ? '<p class="small muted">対応形式：TCGdex の「セット」「カード一覧」「カード」のJSON、またはこのアプリ形式（card_name などを持つ配列）。</p>' : ''}`);
  $('#impFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('#impTxt').value = r.result; }; r.readAsText(f); });
}
function replaceAll(newS) {
  const old = S;
  TABLES.forEach(t => old[t].forEach(r => { if (!newS[t].some(x => x.id === r.id)) del(t, r.id); }));
  TABLES.forEach(t => newS[t].forEach(r => put(t, Object.assign({}, r))));
}
function importBackup(txt) {
  let j; try { j = JSON.parse(txt); } catch (e) { return toast('JSONとして読めませんでした'); }
  const d = j && j.data ? j.data : j;
  // 試作版（v0.1）の形式にも対応
  if (d && Array.isArray(d.cards) && Array.isArray(d.owned)) return importV01(d);
  if (!d || !TABLES.every(t => d[t] == null || Array.isArray(d[t]))) return toast('このアプリのバックアップではありません');
  const ns = emptyState(); TABLES.forEach(t => ns[t] = (d[t] || []).filter(r => r && r.id));
  if (!confirm(`購入 ${ns.purchases.length}件・欲しい ${ns.wishes.length}件 などで置き換えます。よろしいですか？`)) return;
  replaceAll(ns); rebuildIndex(); closeSheet(); go('home'); toast('読み込みました');
}
function importV01(d) {
  if (!confirm(`試作版のデータ（カード${d.cards.length}・欲しい${d.wishes.length}・購入${d.owned.length}）を手動登録カードとして追加します。よろしいですか？`)) return;
  const map = {};
  d.cards.forEach(c => { const id = 'm-' + docId(c.id); map[c.id] = id; if (!S.manualCards.some(x => x.card_id === id)) put('manualCards', { id, card_id: id, card_name: c.name, card_number: c.number || '', set_name: c.pack || '', rarity: c.rarity || '', release_date: '', card_variant: '', is_manual: true, source_name: '試作版から移行', created_at: nowIso() }); });
  d.wishes.forEach(w => put('wishes', { id: uid('w'), card_id: map[w.cardId], qty: 1, target: w.target != null ? w.target : null, priority: 2, memo: '', share: false, created_at: nowIso() }));
  d.owned.forEach(o => { const cid = map[o.cardId]; put('purchases', { id: uid('p'), card_id: cid, price: Number(o.cost) || 0, qty: 1, date: o.date || today(), store: o.store || '', cond: ['美品', '小傷あり', '傷あり'].includes(o.condition) ? o.condition : /PSA/.test(o.condition || '') ? '鑑定品' : '美品', grader: /PSA/.test(o.condition || '') ? 'PSA' : '', grade: (o.condition || '').replace(/\D/g, ''), created_at: nowIso() }); if (o.market != null && o.market !== '') put('prices', { id: uid('v'), card_id: cid, kind: 'market', cond: '指定なし', price: Number(o.market), source: '試作版から移行', recorded_at: nowIso() }); });
  rebuildIndex(); closeSheet(); go('home'); toast('試作版のデータを取り込みました');
}
function importMaster(txt) {
  let j; try { j = JSON.parse(txt); } catch (e) { return toast('JSONとして読めませんでした'); }
  const out = []; let srcName = 'このアプリ形式';
  const fromTcgdexCard = (c, set) => {
    set = set || c.set || {};
    const total = set.cardCount && (set.cardCount.official || set.cardCount.total);
    return { card_id: 'tcgdex:ja:' + c.id, card_name: c.name, card_number: c.localId ? (total ? c.localId + '/' + total : c.localId) : '', set_id: set.id || '', set_name: set.name || '', rarity: c.rarity || '', release_date: set.releaseDate || '', card_variant: '', image_url: c.image || '', source_name: 'TCGdex', source_card_id: c.id, last_updated: nowIso().slice(0, 10) };
  };
  const arr = Array.isArray(j) ? j : [j];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    if (x.card_name) { out.push(Object.assign({ card_id: x.card_id || 'import:' + docId((x.set_id || '') + '-' + (x.card_number || '') + '-' + x.card_name), source_name: x.source_name || 'インポート' }, x)); continue; }
    if (Array.isArray(x.cards) && x.name) { srcName = 'TCGdex'; x.cards.forEach(c => out.push(fromTcgdexCard(c, x))); continue; }
    if (x.id && x.localId && x.name) { srcName = 'TCGdex'; out.push(fromTcgdexCard(x)); continue; }
  }
  const valid = out.filter(c => c.card_name && c.card_id);
  if (!valid.length) return toast('カードを読み取れませんでした。形式を確認してください');
  const m = new Map(MASTER.cards.map(c => [c.card_id, c]));
  let added = 0, updated = 0;
  valid.forEach(c => { if (m.has(c.card_id)) updated++; else added++; m.set(c.card_id, c); });
  const next = { sources: MASTER.sources.concat([{ name: srcName + (valid[0].set_name ? '：' + valid[0].set_name : ''), count: valid.length, imported_at: nowIso() }]), cards: [...m.values()] };
  if (!lsSet(LS_MASTER, next)) return toast('端末の保存容量が足りません');
  MASTER = next; rebuildIndex(); closeSheet(); render(); toast(`追加 ${added}枚・更新 ${updated}枚`);
}

/* ---------- 操作の受付 ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, cid = el.dataset.card, id = el.dataset.id;
  if (el.tagName === 'BUTTON' || el.closest('button')) e.stopPropagation();
  switch (a) {
    case 'go': closeSheet(); go(el.dataset.to); break;
    case 'goSearch': closeSheet(); go('search'); break;
    case 'close': closeSheet(); break;
    case 'card': sheetCard(cid); break;
    case 'shop': sheetShop(cid); break;
    case 'wishEdit': sheetWish(cid); break;
    case 'buy': sheetBuy(cid); break;
    case 'buyEdit': sheetBuy(null, id); break;
    case 'priceEdit': sheetPrice(cid); break;
    case 'manual': sheetManual(); break;
    case 'manualEdit': sheetManual(cid); break;
    case 'link': sheetLink(cid); break;
    case 'linkSearch': sheetLink(cid, val('lq')); break;
    case 'linkDo': doLink(el.dataset.from, el.dataset.to); break;
    case 'sug': q = el.dataset.v; $('#q').value = q; shown = 30; renderResults(); break;
    case 'more': shown += 30; renderResults(); break;
    case 'clearf': fRar = fSet = fYear = ''; renderSearch(); break;
    case 'wsort': wishSort = el.dataset.v; renderWish(); break;
    case 'wishSave': {
      const qty = parseInt(val('wQty'), 10), t = num(val('wTarget'));
      if (!(qty >= 1)) return toast('希望枚数は1以上で入れてください');
      if (Number.isNaN(t)) return toast('目標購入価格は数字で入れてください');
      const w = wishOf(cid);
      put('wishes', Object.assign({}, w || { id: uid('w'), card_id: cid, created_at: nowIso() }, { qty, target: t, priority: Number(val('wPri')) || 2, memo: val('wMemo'), share: $('#wShare').checked }));
      closeSheet(); render(); toast(w ? '欲しい設定を保存しました' : '欲しいカードに追加しました'); break;
    }
    case 'wishDel': { const w = wishOf(cid); if (w && confirm('欲しいリストから外しますか？')) { del('wishes', w.id); closeSheet(); render(); toast('欲しいリストから外しました'); } break; }
    case 'shopBuy': { const p = num(val('sPrice')); const cond = val('sCond'); sheetBuy(cid, null, { price: Number.isNaN(p) ? null : p, store: val('sStore'), cond: CONDITIONS.includes(cond) ? cond : '美品', grader: val('sGrader'), grade: val('sGrade') }); break; }
    case 'buySave': {
      const price = num(val('bPrice')), qty = parseInt(val('bQty'), 10), ship = num(val('bShip')), fee = num(val('bFee'));
      if (price == null || Number.isNaN(price)) return toast('購入価格を数字で入れてください');
      if (!(qty >= 1)) return toast('枚数は1以上で入れてください');
      if (Number.isNaN(ship) || Number.isNaN(fee)) return toast('送料・手数料は数字で入れてください');
      const old = id ? S.purchases.find(x => x.id === id) : null;
      const rec = Object.assign({}, old || { id: uid('p'), card_id: cid, created_at: nowIso() }, { price, qty, date: val('bDate') || today(), store: val('bStore'), shipping: ship || 0, fee: fee || 0, cond: val('bCond') || '美品', grader: val('bGrader'), grade: val('bGrade'), memo: val('bMemo') });
      put('purchases', rec);
      const w = wishOf(rec.card_id), have = ownedQty(rec.card_id);
      closeSheet(); render();
      toast(old ? '購入記録を保存しました' : (w ? (have >= (w.qty || 1) ? '記録しました。希望枚数がそろいました' : `記録しました。あと${(w.qty || 1) - have}枚`) : '記録しました。コレクションに追加されました'));
      break;
    }
    case 'buyDel': { const p = S.purchases.find(x => x.id === id); if (p && confirm(`${yen(p.price)} × ${p.qty || 1}枚（${p.date || ''}）の購入記録を削除します。元に戻せません。よろしいですか？`)) { del('purchases', id); closeSheet(); render(); toast('購入記録を削除しました'); } break; }
    case 'priceSave': {
      const p = num(val('pPrice')); if (p == null || Number.isNaN(p)) return toast('金額を数字で入れてください');
      const cond = val('pCond');
      put('prices', { id: uid('v'), card_id: cid, kind: val('pKind'), cond, grader: cond === '鑑定品' ? val('pGrader') : '', grade: cond === '鑑定品' ? val('pGrade') : '', price: p, source: val('pSrc') || '手動入力', recorded_at: nowIso() });
      closeSheet(); render(); sheetCard(cid); toast('参考価格を保存しました'); break;
    }
    case 'priceDel': { const p = S.prices.find(x => x.id === id); if (p && confirm('この参考価格の記録を削除しますか？')) { del('prices', id); sheetCard(p.card_id); render(); } break; }
    case 'manualSave': {
      const name = val('mName'); if (!name) return toast('カード名を入れてください');
      const old = cid ? S.manualCards.find(x => x.card_id === cid) : null;
      const newId = old ? old.card_id : 'm-' + uid('');
      const dup = !old && S.manualCards.find(x => !x.linked_to && CS.norm(x.card_name) === CS.norm(name) && CS.norm(x.card_number || '') === CS.norm(val('mNum')) && CS.norm(x.rarity || '') === CS.norm(val('mRar')));
      if (dup && !confirm('同じ内容の手動登録カードがすでにあります。それでも新しく登録しますか？')) { sheetCard(dup.card_id); return; }
      put('manualCards', Object.assign({}, old || { id: newId, card_id: newId, created_at: nowIso() }, { card_name: name, card_number: val('mNum'), rarity: val('mRar').toUpperCase(), set_name: val('mSet'), release_date: val('mDate'), card_variant: val('mVar'), is_manual: true, source_name: '手動登録' }));
      rebuildIndex(); render(); sheetCard(newId); toast(old ? '保存しました' : '手動登録しました'); break;
    }
    case 'metaSave': {
      const m = metaOf(cid);
      put('cardMeta', Object.assign({}, m || { id: docId(cid), card_id: cid }, { fav: $('#mFav').checked, location: val('mLoc'), memo: val('mMemo'), albums: [...document.querySelectorAll('.mAl:checked')].map(x => x.value) }));
      render(); toast('メモを保存しました'); break;
    }
    case 'albumAdd': { const n = (prompt('アルバムの名前（例：SARコレクション）') || '').trim(); if (n) { put('albums', { id: uid('a'), name: n, created_at: nowIso() }); renderCollection(); } break; }
    case 'albumDel': { const al = S.albums.find(x => x.id === id); if (al && confirm(`アルバム「${al.name}」を削除しますか？カードや購入記録は消えません。`)) { S.cardMeta.filter(m => (m.albums || []).includes(id)).forEach(m => put('cardMeta', Object.assign({}, m, { albums: m.albums.filter(x => x !== id) }))); del('albums', id); if (colAlbum === id) colAlbum = ''; renderCollection(); } break; }
    case 'login': sendLoginMail(val('loginEmail')); break;
    case 'logout': if (confirm('ログアウトしますか？（この端末の控えは残ります）')) sb.auth.signOut().finally(() => { sbUser = null; cloud = null; setSync('login'); if (tab === 'settings') renderSettings(); toast('ログアウトしました'); }); break;
    case 'export': exportBackup(); break;
    case 'copyExp': { const t = $('#expTxt'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(() => toast('コピーしました')).catch(() => { document.execCommand('copy'); toast('コピーしました'); }); break; }
    case 'importOpen': importSheet('backup'); break;
    case 'importDo': importBackup($('#impTxt').value); break;
    case 'masterOpen': importSheet('master'); break;
    case 'masterDo': importMaster($('#impTxt').value); break;
    case 'masterClear': if (confirm('読み込んだカードデータを消します（購入記録などは残ります）。よろしいですか？')) { MASTER = { sources: [], cards: [] }; lsSet(LS_MASTER, MASTER); rebuildIndex(); renderSettings(); } break;
    case 'wipe': if (confirm('購入記録・欲しいカード・手動登録カードなど、すべて消します。元に戻せません。') && confirm('本当に消去しますか？')) { replaceAll(emptyState()); rebuildIndex(); go('home'); toast('すべて消去しました'); } break;
  }
});
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
$('#gear').addEventListener('click', () => go('settings'));
$('#sync').addEventListener('click', () => go('settings'));

// 試作版のデータが残っていれば案内
(function () { try { const old = localStorage.getItem('mypokeca-v01'); if (old && !lsGet('mpk-v01-asked', false)) { lsSet('mpk-v01-asked', true); const d = JSON.parse(old); if (d && d.owned && (d.owned.length || d.wishes.length) && confirm('試作版のデータが見つかりました。新しい版に取り込みますか？')) importV01(d); } } catch (e) { } })();

async function loadBundled() {
  try {
    const res = await fetch('data/cards-ja.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const j = await res.json();
    const sets = j.sets || {};
    BUNDLED = {
      generated_at: j.generated_at || '', source: j.source || '', sets: Object.keys(sets).length,
      cards: (j.cards || []).map(r => { const st = sets[r[3]] || []; return { card_id: r[0], card_name: r[1], card_number: r[2], set_id: r[3], set_name: st[0] || r[3], rarity: r[4] || '', release_date: st[1] || '', card_variant: r[5] || '', rarity_raw: r[6], image_url: '', source_name: 'TCGdex', source_card_id: r[7], last_updated: (j.generated_at || '').slice(0, 10) }; })
    };
    rebuildIndex(); render();
  } catch (e) { /* 同梱データがない環境（claude.ai 上など）では何もしない */ }
}

rebuildIndex();
go('home');
loadBundled();
setSync('local');
connectCloud();
})();
