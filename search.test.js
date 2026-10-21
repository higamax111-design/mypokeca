const S=require('./search.js'), cards=require('./testcards.js');
const idx=S.buildIndex(cards);
let pass=0,fail=0,fails=[];
const ids=r=>r.results.map(x=>x.card.card_id);
function check(label,ok){ if(ok)pass++; else {fail++;fails.push(label);} }
const t0=Date.now();
// 1. 全カード：正式名称で検索すると結果に含まれる / 名前+番号で1位
for(const c of cards){
  const r=S.search(idx,c.card_name); check('名前:'+c.card_name+' '+c.card_number, ids(r).includes(c.card_id));
  const r2=S.search(idx,c.card_name+' '+c.card_number); const same=cards.filter(o=>o.card_name===c.card_name&&S.numKey(o.card_number).num===S.numKey(c.card_number).num&&(!S.numKey(c.card_number).den||true)).length;
  check('名前+番号で上位:'+c.card_name+' '+c.card_number, ids(r2).slice(0,same).includes(c.card_id) && r2.results.every(x=>S.numKey(x.card.card_number).num===S.numKey(c.card_number).num));
  const r3=S.search(idx,c.card_number); check('番号:'+c.card_number, ids(r3).includes(c.card_id));
  const r4=S.search(idx,c.card_name,{rarity:c.rarity}); check('名前+レア絞込:'+c.card_name+' '+c.rarity, ids(r4).includes(c.card_id) && r4.results.every(x=>x.card.rarity===c.rarity));
}
// 2. 表記揺れ
const cases=[
 ['ぶらっきー','ブラッキー'],['ﾌﾞﾗｯｷｰ','ブラッキー'],['ブラッキーEX','ブラッキーEX'],['ブラッキー ＥＸ','ブラッキーEX'],['ぶらっきーex','ブラッキーex'],
 ['ブラッキー　ex','ブラッキーex'],['ブラッキーＶＭＡＸ','ブラッキーVMAX'],['ぶらっきーvmax','ブラッキーVMAX'],['りざーどん','リザードン'],
 ['ナンジャモ','ナンジャモ'],['なんじゃも','ナンジャモ'],['ｎのぞろあーく','Nのゾロアーク'],['はかせのけんきゅう','博士の研究'],
 ['にどらん♀','ニドラン♀'],['ポリゴン２','ポリゴン2'],['オーガポンみどりのめんex','オーガポン みどりのめんex'],['がちぐま','ガチグマ アカツキex'],
 ['かがやく げっこうが','かがやくゲッコウガ'],['メガリザードンＸ','メガリザードンXex'],['ぶいず','イーブイ'],['ブイズ','ニンフィアex'],['ハカセ','博士の研究'],['ボスシ','ボスの指令'],
];
for(const [q,name] of cases){ const r=S.search(idx,q); check('揺れ:'+q+'→'+name, r.results.some(x=>x.card.card_name===name)); }
// 3. 入力ミス
const typos=[['ブラッキ-ex','ブラッキーex'],['リザードンex','リザードンex'],['リザドンex','リザードンex'],['ガブリアアス','ガブリアス'],['ミミッキョ','ミミッキュ'],['タケルライコx','タケルライコex'],['ナンジャモo','ナンジャモ']];
for(const [q,name] of typos){ const r=S.search(idx,q); check('ミス:'+q+'→'+name, r.results.slice(0,10).some(x=>x.card.card_name===name)); }
// 4. 番号形式
const nums=[['217/165','test:T09-217_165'],['２１７／１６５','test:T09-217_165'],['#217','test:T09-217_165'],['217','test:T09-217_165'],['T09-217','test:T09-217_165'],['t09 217','test:T09-217_165'],['001/SV-P','test:TPR-001_SV-P'],['001/sv-p','test:TPR-001_SV-P'],['1/165',null],['ブラッキー 217','test:T09-217_165']];
for(const [q,id] of nums){ const r=S.search(idx,q); check('番号形式:'+q, id? ids(r).includes(id) && (q==='217'||q==='#217'||ids(r)[0]===id) : true); }
// 5. レアリティ入り検索
const rq=[['ブラッキー SAR','test:T09-217_165'],['ブラッキーexSAR','test:T09-217_165'],['ぶらっきーex sar','test:T09-217_165'],['リザードンex SAR','test:T09-201_165'],['ブラッキーV SR',null]];
for(const [q,id] of rq){ const r=S.search(idx,q); check('レア入り:'+q, id? ids(r)[0]===id : r.results.length===2 && r.results.every(x=>x.card.rarity==='SR'&&x.card.card_name==='ブラッキーV')); }
// 6. 同名異カードの区別（ブラッキーex は3枚が別々に出る）
{ const r=S.search(idx,'ブラッキーex'); const ex=r.results.filter(x=>x.card.card_name==='ブラッキーex'); check('同名異カード3枚', ex.length===3 && new Set(ex.map(x=>x.card.card_id)).size===3); }
// 7. 完全一致が先頭（ミュウ で ミュウツー より ミュウ が先）
{ const r=S.search(idx,'ミュウ'); check('完全一致優先 ミュウ', r.results[0].card.card_name==='ミュウ' && r.results.some(x=>x.card.card_name==='ミュウツー')); }
{ const r=S.search(idx,'ブラッキーV'); check('完全一致優先 ブラッキーV', r.results.slice(0,3).every(x=>x.card.card_name==='ブラッキーV')); }
// 8. 異なるカードを混ぜない（ex と EX は別カード、検索ではどちらも出るが ID は別）
{ const a=S.search(idx,'ブラッキーex'); check('ex/EX別ID', new Set(a.results.map(x=>x.card.card_id)).size===a.results.length); }
// 9. 古いカード
{ const r=S.search(idx,'ブラッキー',{year:'1996'}); check('古いカード年絞込', r.results.length===1 && r.results[0].card.set_id==='T01'); }
// 10. 0件
{ const r=S.search(idx,'あいうえおかきく'); check('0件', r.results.length===0); }
// 11. 候補表示
{ const s=S.suggest(idx,'ぶら'); check('候補 ぶら', s.length>0 && s[0].name.startsWith('ブラッキー')); }
// 速度：2万5千枚に増やして計測
const big=[]; for(let k=0;k<250;k++) for(const c of cards) big.push({...c,card_id:c.card_id+'#'+k,card_name:k? c.card_name+(k%7?'':'') : c.card_name, set_id:c.set_id+k});
const bidx=S.buildIndex(big); const qs=['ブラッキー','ぶらっきーex sar','217/165','リザドンex','ナンジャモ','ミミッキョ'];
const times=qs.map(q=>{const t=performance.now(); for(let i=0;i<5;i++) S.search(bidx,q); return ((performance.now()-t)/5).toFixed(1)+'ms '+q;});
console.log('合格',pass,'/',pass+fail,' 不合格',fail); fails.forEach(f=>console.log('  NG',f));
console.log('件数(テスト)',cards.length,' 速度(約'+big.length+'枚):',times.join(' / '));
