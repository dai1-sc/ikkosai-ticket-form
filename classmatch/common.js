"use strict";
/* 共通ロジック：データの読み書き・順位計算・トーナメント判定 */

const $ = (s, el = document) => el.querySelector(s);
// どの競技のページか（ページ側で common.js の前に window.SPORT = "soccer" のように指定。指定がなければドッチボール）
const SPORT_ID = (typeof window !== "undefined" && window.SPORT) || "dodgeball";
const SP = CONFIG.SPORTS[SPORT_ID];   // この競技の設定（config.js の SPORTS の中身）
const LEAGUES = SP.leagues;
const P = SP.points || { win: 3, draw: 1, lose: 0 };
const sgn = n => (n > 0 ? "+" + n : n < 0 ? String(n) : "±0");
const leagueOf = c => LEAGUES.find(L => L.classes.includes(c));

/* ---------- データ保存（Googleスプレッドシート or テストモード） ---------- */
/*
  通信できなくても使えるようにしてあります。
  ・書き込み（保存・取り消し・同率順位）は、まず端末の「未送信キュー」に入り、通信できるときに順番に自動送信されます。
  ・読み込みは、通信できれば最新を取得して端末に控え(キャッシュ)を残し、できなければ「控え＋未送信分」を表示します。
*/
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量不足など */ } },
};
const EMPTY = () => ({ results: {}, overrides: {} });

function applyOp(d, op) {
  if (op.action === "save") d.results[op.record.id] = op.record;
  else if (op.action === "delete") delete d.results[op.id];
  else if (op.action === "override") {
    if (op.order && op.order.length) d.overrides[op.league] = op.order; else delete d.overrides[op.league];
  } else if (op.action === "reset") { d.results = {}; d.overrides = {}; }
}
function finalizeAll(d) {
  const results = {};
  Object.keys(d.results).forEach(k => { results[k] = finalize(d.results[k]); });
  return { results, overrides: d.overrides || {} };
}

// sport は "dodgeball"（既定）／"soccer"／"volleyball"。競技ごとに保存先（端末内・スプレッドシートのシート）が別になる。
function makeAPI(sport) {
const sfx = sport === "dodgeball" ? "" : "_" + sport;
return {
  local: !CONFIG.API_URL,
  KEY: "dodge_local_v2" + sfx,      // テストモードの保存先
  CACHE: "dodge_cache_v2" + sfx,    // 最後に取得したサーバーの内容
  OUTBOX: "dodge_outbox_v2" + sfx,  // 未送信の操作
  offline: false, flushing: null, failAt: 0,

  readLocal() { return LS.get(this.KEY, EMPTY()); },
  pending() { return this.local ? 0 : LS.get(this.OUTBOX, []).length; },

  async fetchJSON(url, opt) {
    // 直前に通信できなかったときは20秒ほど試さない（保存のたびに待たされないように）
    if ((typeof navigator !== "undefined" && navigator.onLine === false) || Date.now() - this.failAt < 20000) throw new Error("オフライン");
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch(url, { ...opt, signal: ctl.signal });
      if (!res.ok) throw new Error("通信エラー");
      const j = await res.json();
      this.failAt = 0;
      return j;
    } catch (e) { this.failAt = Date.now(); throw e; }
    finally { clearTimeout(t); }
  },
  // 送信を試す。2.5秒で結果が出なければ待たずに先へ進む（残りは裏で続き、できなければ未送信のまま残る）
  quickFlush() { return Promise.race([this.flush(), new Promise(r => setTimeout(r, 2500))]); },

  async load() {
    if (this.local) return finalizeAll(this.readLocal());
    await this.quickFlush();
    let base;
    try {
      const d = await this.fetchJSON(CONFIG.API_URL + "?action=all&t=" + Date.now() + (sport === "dodgeball" ? "" : "&sport=" + sport));
      const results = {};
      (d.results || []).forEach(r => { results[r.id] = r; });
      base = { results, overrides: d.overrides || {} };
      LS.set(this.CACHE, base);
      this.offline = false;
    } catch (e) {
      base = LS.get(this.CACHE, null);
      if (!base) throw new Error("通信できず、この端末に保存された控えもありません。一度、通信できる場所でページを開いてください");
      this.offline = true;
    }
    const d = JSON.parse(JSON.stringify(base));
    LS.get(this.OUTBOX, []).forEach(op => applyOp(d, op));
    return finalizeAll(d);
  },

  // 操作を記録する（通信は後回しにできる）
  put(op) {
    if (this.local) { const d = this.readLocal(); applyOp(d, op); LS.set(this.KEY, d); return; }
    const q = LS.get(this.OUTBOX, []); q.push(op); LS.set(this.OUTBOX, q);
  },
  async post(op) { this.put(op); await this.quickFlush(); },

  // 未送信の操作を古い順に送る。通信できなければ残したまま終わる（失敗しても例外は出さない）
  flush() {
    if (this.local) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (LS.get(this.OUTBOX, []).length) {
        const op = LS.get(this.OUTBOX, [])[0];
        try {
          // text/plain で送る（Apps Script で CORS の事前確認が不要になる）
          const j = await this.fetchJSON(CONFIG.API_URL, { method: "POST", body: JSON.stringify(sport === "dodgeball" ? op : { ...op, sport }) });
          if (!j.ok) console.warn("送信を受け付けられませんでした", j.error);
        } catch (e) { this.offline = true; return; }
        const q = LS.get(this.OUTBOX, []); q.shift(); LS.set(this.OUTBOX, q);
        this.offline = false;
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  },

  /* 端末どうしでファイルを受け渡すとき用（通信が全くないとき） */
  raw() {
    if (this.local) return this.readLocal();
    const d = JSON.parse(JSON.stringify(LS.get(this.CACHE, EMPTY())));
    LS.get(this.OUTBOX, []).forEach(op => applyOp(d, op));
    return d;
  },
  exportJSON() { return JSON.stringify({ app: "dodgeball", sport, exported: new Date().toISOString(), ...this.raw() }); },
  async importJSON(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { throw new Error("ファイルを読み取れません"); }
    if (!d || d.app !== "dodgeball" || (d.sport || "dodgeball") !== sport || typeof d.results !== "object") throw new Error("このサイトの書き出しファイルではありません");
    const ids = Object.keys(d.results);
    ids.forEach(id => {
      const r = d.results[id];
      if (!r || r.id !== id || typeof r.games !== "string") throw new Error("結果の形式が正しくありません（" + id + "）");
    });
    ids.forEach(id => this.put({ action: "save", record: d.results[id] }));
    Object.keys(d.overrides || {}).forEach(l => this.put({ action: "override", league: Number(l), order: d.overrides[l] }));
    await this.flush();
    return ids.length;
  },
};
}
let API = makeAPI(SPORT_ID);

/* 通信状態の表示（#net がある画面だけ） */
function renderNet() {
  const el = document.getElementById("net");
  if (!el || API.local) return;
  const n = API.pending();
  if (!API.offline && !n) { el.innerHTML = ""; return; }
  el.innerHTML = '<div class="banner">' + (API.offline ? "通信できません。" : "") +
    (n ? `未送信の結果が ${n} 件あります（この端末には保存済みです。通信が戻ると自動で送信されます）。`
       : "この端末に残っている最後の内容を表示しています。") + "</div>";
}

/* 「通信できないとき」の書き出し／取り込み（#offline がある画面だけ） */
function mountOfflineTools(el, after) {
  if (!el) return;
  el.innerHTML = `<h2 class="group">通信できないとき</h2>
    <p class="hint">入力した結果はこの端末にも保存されています。端末どうしで受け渡すときは、書き出したファイルをUSBメモリやニアバイシェアなどで本部の端末に移し、取り込んでください。同じ試合の結果は、取り込んだファイルの内容で上書きされます。</p>
    <div class="offtools"><button type="button" class="ghost" data-x="ex">この端末の結果を書き出す</button>
    <button type="button" class="ghost" data-x="im">結果ファイルを取り込む</button></div>
    <input type="file" accept=".json,application/json" hidden><p class="hint" data-x="msg"></p>`;
  const inp = el.querySelector("input"), msg = el.querySelector('[data-x="msg"]');
  el.addEventListener("click", e => {
    const x = e.target.dataset && e.target.dataset.x;
    if (x === "ex") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([API.exportJSON()], { type: "application/json" }));
      const t = new Date();
      a.download = `${SPORT_ID}-results-${String(t.getHours()).padStart(2, "0")}${String(t.getMinutes()).padStart(2, "0")}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      msg.textContent = "書き出しました（ダウンロードフォルダを確認してください）";
    } else if (x === "im") inp.click();
  });
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    inp.value = "";
    if (!f || !confirm("同じ試合の結果は、ファイルの内容で上書きされます。取り込みますか？")) return;
    try { const n = await API.importJSON(await f.text()); msg.textContent = `${n}試合分を取り込みました`; if (after) after(); }
    catch (err) { msg.textContent = "取り込めませんでした：" + err.message; }
  });
}

/* 通信が戻ったら自動で未送信分を送る／ページを通信なしでも開けるようにする */
if (typeof window !== "undefined") {
  const kick = () => API.flush().then(renderNet);
  window.addEventListener("online", () => { API.failAt = 0; kick(); });
  if (!API.local) setInterval(kick, 15000);
  if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});

  // 本番の設定のはずなのに（この端末に本番の控えがあるのに）テストモードで開いた＝古いファイルが端末に残っている。
  // 古い控えを消して、1回だけ自動で読み込み直す。
  try {
    if (API.local && (LS.get(API.CACHE, null) || LS.get(API.OUTBOX, []).length) && !sessionStorage.getItem("dodge_heal")) {
      sessionStorage.setItem("dodge_heal", "1");
      (async () => {
        try {
          if ("serviceWorker" in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
          if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
        } catch (e) { /* 無視 */ }
        location.reload();
      })();
    }
  } catch (e) { /* sessionStorage が使えない場合など */ }

  // 古い config.js が表示されてテストモードになっているときは、最新を取り直して一度だけ読み込み直す
  if (API.local && /^https?:/.test(location.protocol)) {
    fetch("config.js", { cache: "reload" }).then(r => r.text()).then(t => {
      if (/API_URL:\s*"[^"]+"/.test(t) && !sessionStorage.getItem("cfgfix")) { sessionStorage.setItem("cfgfix", "1"); location.reload(); }
    }).catch(() => {});
  }
}

/* ---------- 試合の一覧（リーグ戦） ---------- */
// 試合の一覧を作る。sched は進行順（[左, 右] の並び）。競技ごとに別の進行順を使える。
function buildMatches(sched) {
  const LM = {}, ALL = [];
  sched = sched || [];
  const order = (a, b) => {
    const i = sched.findIndex(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
    return i < 0 ? 999 : i;
  };
  LEAGUES.forEach(L => {
    const n = L.classes.length, list = [];
    for (let i = 0; i < n; i++) {
      let a = L.classes[i], b = L.classes[(i + 1) % n];
      if (sched.some(p => p[0] === b && p[1] === a)) [a, b] = [b, a]; // 左右の向きは SCHEDULE に合わせる
      list.push({ id: `M${Math.min(a, b)}-${Math.max(a, b)}`, a, b, league: L.id, ord: order(a, b), kind: "league" });
    }
    LM[L.id] = list.slice().sort((x, y) => x.ord - y.ord);
    ALL.push(...list);
  });
  ALL.sort((x, y) => x.ord - y.ord || x.league - y.league);
  ALL.forEach((m, i) => { m.no = i + 1; });
  return { LM, ALL };
}
const _bm = buildMatches(SP.schedule);
const LEAGUE_MATCHES = _bm.LM;
const ALL_LEAGUE_MATCHES = _bm.ALL;

/* ---------- 結果の扱い ---------- */
/*
  1試合の記録：{ id, a, b, games: [[aの内野残り, bの内野残り], ...] }
  ここから次の4つを計算して持たせる（finalize）
    sa, sb … 勝ったゲーム数（試合の勝敗はこれで決まる）
    ia, ib … 得点。試合に勝った側が「勝ったゲーム」の内野差を合計したもの（負けた側は0。負けた側が勝ったゲームの内野差は数えない）
  例）1組勝(差2)・2組勝(差3)・1組勝(差3) → 1組の勝ち 2対1、ia=5, ib=0（得失点差 1組+5）
*/
const gameDone = g => !!g && Number.isInteger(g[0]) && Number.isInteger(g[1]);
// 保存形式の例："4-1|2-5|3-3|S2-1"（各ゲームの内野の残り人数。最後の S から始まる部分がサドンデスの内野の残り人数）
const encGames = (gs, sd) => gs.map(g => g[0] + "-" + g[1]).join("|") + (sd ? "|S" + sd[0] + "-" + sd[1] : "");
const decGames = s => String(s || "").split("|").filter(Boolean)
  .map(t => t.split("-").map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
const decSD = s => { const m = String(s || "").match(/\|S(\d+)-(\d+)\s*$/); return m ? [Number(m[1]), Number(m[2])] : null; };

/*
  勝者 w の決め方：①勝ちゲーム数 → ②並んだら勝ったゲームの内野差の合計（tb="diff"）
                    → ③それも同じならサドンデス（tb="sd"）。サドンデスも普通のゲームと同じく「内野の残り人数」を入れ、
                       勝った方の勝ちゲームに数える（内野差も得失点に加わる）。
  w="D" は「サドンデスの人数がまだ入っていない」状態。
*/
function tally(games, sd) {
  let wa = 0, wb = 0, da = 0, db = 0;
  games.forEach(([x, y]) => {
    if (x > y) { wa++; da += x - y; } else if (y > x) { wb++; db += y - x; }
  });
  let w, tb = null;
  if (wa !== wb) w = wa > wb ? "A" : "B";
  else if (da !== db) { w = da > db ? "A" : "B"; tb = "diff"; }
  else {
    tb = "sd"; w = "D";
    if (gameDone(sd) && sd[0] !== sd[1]) {
      if (sd[0] > sd[1]) { wa++; da += sd[0] - sd[1]; w = "A"; } else { wb++; db += sd[1] - sd[0]; w = "B"; }
    }
  }
  return { sa: wa, sb: wb, ia: w === "A" ? da : 0, ib: w === "B" ? db : 0, w, tb };
}

// 入力欄に出すゲーム数：最低 min 、勝ちゲーム数が並んでいれば次のゲームを出す（最大 max）
function gameCount(games) {
  const G = SP.games, max = G.max;
  let n = G.min;
  while (n < max) {
    const g = games.slice(0, n);
    if (g.length < n || !g.every(gameDone)) break;
    const t = tally(g);
    if (t.sa !== t.sb) break;
    n++;
  }
  return n;
}

function finalize(r) {
  const games = typeof r.games === "string" ? decGames(r.games) : Array.isArray(r.games) ? r.games : [];
  const sd = typeof r.games === "string" ? decSD(r.games) : Array.isArray(r.sd) ? r.sd : null;
  if (games.length) return { ...r, games, sd, ...tally(games, sd) };
  // ゲームの無い競技（サッカー・バレーボール）：sa と sb の大きい方が勝ち。同点は PK 戦などの勝者（pk）で決める
  const pk = (String(r.games || "").match(/PK([AB])/) || [])[1] || r.pk || null;
  const w = r.sa > r.sb ? "A" : r.sa < r.sb ? "B" : pk || "D";
  return { ...r, games: [], pk, w };
}

// 記録を「a が左側」の向きにそろえる
function orient(r, a) {
  if (r.a === a) return r;
  const flip = x => (x === "A" ? "B" : x === "B" ? "A" : x);
  return { ...r, a: r.b, b: r.a, sa: r.sb, sb: r.sa, ia: r.ib, ib: r.ia, w: flip(r.w), pk: flip(r.pk), sd: r.sd ? [r.sd[1], r.sd[0]] : null, games: (r.games || []).map(g => [g[1], g[0]]) };
}
const getRec = (m, results) => (results[m.id] ? orient(results[m.id], m.a) : null);
// "A"=左の勝ち "B"=右の勝ち "D"=引き分け（スコアで判定）
const outcome = r => r.w || (r.sa > r.sb ? "A" : r.sa < r.sb ? "B" : "D");
// 引き分けなし：勝者が決まっていなければ null（サドンデス待ち）
function koWinner(r) {
  const o = outcome(r);
  return o === "A" ? r.a : o === "B" ? r.b : null;
}

/* ---------- リーグ順位 ---------- */
// 競技の設定 rank が "rate" のときは 勝点ではなく 勝率（勝＝1・分＝0.5）で並べる（サッカー・バレーボール用）
function standings(L, results, overrides) {
  const ms = LEAGUE_MATCHES[L.id];
  const rows = L.classes.map(c => ({ c, p: 0, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, diff: 0 }));
  const by = {};
  rows.forEach(r => { by[r.c] = r; });
  let done = 0;
  ms.forEach(m => {
    const r = getRec(m, results);
    if (!r) return;
    done++;
    const A = by[m.a], B = by[m.b], o = outcome(r);
    A.p++; B.p++;
    A.gf += r.ia; A.ga += r.ib; B.gf += r.ib; B.ga += r.ia;
    if (o === "A") { A.w++; B.l++; A.pts += P.win; B.pts += P.lose; }
    else if (o === "B") { B.w++; A.l++; B.pts += P.win; A.pts += P.lose; }
    else { A.d++; B.d++; A.pts += P.draw; B.pts += P.draw; }
  });
  rows.forEach(r => { r.diff = r.gf - r.ga; });

  // 順位：勝点 → 得失点差。同じなら「順位決定サドンデス」で決める（TIEBREAK で 得点・直接対決 を使うこともできる）
  const TB = SP.tiebreak || {};
  rows.forEach(r => { r.rate = r.p ? (2 * r.w + r.d) / (2 * r.p) : 0; });
  // 勝率の比較は分数の掛け算で行う（小数の誤差を避ける）
  const rateCmp = (x, y) => (2 * y.w + y.d) * Math.max(1, x.p) - (2 * x.w + x.d) * Math.max(1, y.p);
  const cmp = (x, y) => (SP.rank === "rate" ? rateCmp(x, y) : y.pts - x.pts) || y.diff - x.diff || (TB.gf ? y.gf - x.gf : 0);
  rows.sort(cmp);

  const ov = (overrides[L.id] || []).map(Number);
  const sorted = [];
  let undecided = false, i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && cmp(rows[i], rows[j]) === 0) j++;
    const g = rows.slice(i, j);
    let tie = false;
    if (g.length > 1) {
      let resolved = false;
      if (TB.head && g.length === 2) { // 2組だけの同率は直接対決（TIEBREAK.head が true のときだけ）
        const m = ms.find(m => (m.a === g[0].c && m.b === g[1].c) || (m.a === g[1].c && m.b === g[0].c));
        const r = m && getRec(m, results);
        if (r && outcome(r) !== "D") {
          const winner = outcome(r) === "A" ? m.a : m.b;
          if (winner === g[1].c) g.reverse();
          resolved = true;
        }
      }
      if (!resolved) {
        if (g.every(x => ov.includes(x.c))) { // 本部が手動で決めた順位
          g.sort((x, y) => ov.indexOf(x.c) - ov.indexOf(y.c));
          g.forEach(x => { x.manual = true; });
        } else {
          tie = true;
          g.sort((x, y) => x.c - y.c);
        }
      }
    }
    g.forEach((x, k) => { x.pos = i + k + 1; x.tie = tie; x.rank = tie ? i + 1 : i + k + 1; });
    if (tie && i < SP.advance) undecided = true; // 進出順位に関わる同率
    sorted.push(...g);
    i = j;
  }
  const complete = done === ms.length;
  return {
    league: L, rows: sorted, done, total: ms.length, complete, undecided,
    settled: complete && !undecided,
    tied: sorted.filter(r => r.tie && r.rank <= SP.advance),
  };
}

/* ---------- 決勝・3位決定戦（全試合数＝リーグ戦＋2試合） ---------- */
// 組み合わせは競技の設定 bracket で決める。"リーグid-順位" の組。
//   既定：決勝＝各リーグ1位どうし（"1-1" と "2-1"）／3位決定戦＝各リーグ2位どうし（"1-2" と "2-2"）
function bracket(sts, results) {
  const B = SP.bracket || { final: ["1-1", "2-1"], third: ["1-2", "2-2"] };
  const ref = t => {
    const [lid, k] = t.split("-").map(Number), i = LEAGUES.findIndex(L => L.id === lid);
    return { name: LEAGUES[i].name + k + "位", st: sts[i], k };
  };
  const pick = r => (r.st.settled ? r.st.rows[r.k - 1].c : null);   // 確定
  const prov = r => (r.st.done > 0 ? r.st.rows[r.k - 1].c : null);  // 暫定
  const mk = (id, name, pair) => {
    const A = ref(pair[0]), Bt = ref(pair[1]), a = pick(A), b = pick(Bt);
    const raw = results[id];
    let rec = null, stale = false;
    if (raw) {
      if (a && b && ((raw.a === a && raw.b === b) || (raw.a === b && raw.b === a))) rec = orient(raw, a);
      else stale = true; // リーグ戦の修正で対戦カードが変わった
    }
    const winner = rec ? koWinner(rec) : null;
    return {
      id, name, title: name, sub: "決勝・3位決定戦", aSrc: A.name, bSrc: Bt.name, a, b, pa: prov(A), pb: prov(Bt), rec, stale,
      winner, loser: winner ? (winner === a ? b : a) : null, ready: !!(a && b), ko: true,
    };
  };
  return [mk("F", "決勝", B.final), mk("TP", "3位決定戦", B.third)];
}

if (typeof module !== "undefined") {
  module.exports = { standings, bracket, getRec, outcome, koWinner, LEAGUE_MATCHES, ALL_LEAGUE_MATCHES };
}
