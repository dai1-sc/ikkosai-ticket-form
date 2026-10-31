"use strict";
/* サッカー・バレーボール用の本部ページ：結果の入力・リーグ表・得失点差・決勝／3位決定戦
   （どちらの競技かは、ページ側で window.SPORT に指定する） */

const S = SP;                                                  // この競技の設定
const MATCHES = { LM: LEAGUE_MATCHES, ALL: ALL_LEAGUE_MATCHES };  // リーグ戦の一覧（進行順つき。設定の schedule から作られる）
let DATA = null, STS = [], KO = [], timer = null, loading = false, sig = "";
const draft = {};  // 同率の手動並べ替え（作業中）
const ED = {};     // 入力欄の下書き：試合id → { sa, sb, pk, dirty }

const nm = c => c + "組";
const pct = r => Math.round(r * 1000) / 10 + "%";

document.getElementById("t").textContent = CONFIG.EVENT + " " + S.title;
document.title = S.title + " 本部用";
if (API.local) {
  $("#banner").innerHTML = '<div class="banner">テストモードです。結果はこの端末のブラウザ内にだけ保存されます（config.js の API_URL が未設定）。本番のはずなのにこの表示が出る場合は、Ctrl＋Shift＋R で読み込み直してください。 <button type="button" class="link" id="reset">テストデータを全て消す</button></div>';
}
$("#rules").textContent =
  `順位の決め方：勝率（勝ち＝1・引き分け＝0.5・負け＝0）→ 得失点差（各試合のスコアの差の合計）。勝率も得失点差も同じときは、抽選・PK戦などで決めた順に手動で確定します。` +
  `各リーグ1位どうしが決勝、2位どうしが3位決定戦です（全${MATCHES.ALL.length + 2}試合）。` +
  (S.draw ? "リーグ戦の引き分けは認め、決勝・3位決定戦で同点のときはPK戦（または延長）の勝者を入力します。" : "引き分けはありません。");

/* ---------- リーグの図（五角形・四角形） ---------- */
function leagueSVG(L, st) {
  const n = L.classes.length, R = n === 4 ? 160 : 150, cx = 220, cy = 205;
  const V = L.classes.map((c, i) => {
    const a = (L.startAngle + (360 / n) * i) * Math.PI / 180;
    return { c, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
  const rankOf = {}, played = {};
  st.rows.forEach(r => { rankOf[r.c] = r.rank; played[r.c] = r.p; });
  const f = v => v.toFixed(1);
  const mark = (rec, c) => {
    const o = outcome(rec);
    if (o === "D") return ["△", "d"];
    return (o === "A") === (rec.a === c) ? ["○", "w"] : ["●", "l"];
  };
  let lines = "", marks = "";
  for (let i = 0; i < n; i++) {
    const p = V[i], q = V[(i + 1) % n];
    const m = LEAGUE_MATCHES[L.id].find(m => (m.a === p.c && m.b === q.c) || (m.a === q.c && m.b === p.c));
    const rec = m && getRec(m, DATA.results);
    const at = t => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    lines += `<line class="edge${rec ? " played" : ""}" x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}"/>`;
    const mid = at(0.5);
    if (rec) {
      const sp = rec.a === p.c ? rec.sa : rec.sb, sq = rec.a === p.c ? rec.sb : rec.sa;
      const [mp, cp] = mark(rec, p.c), [mq, cq] = mark(rec, q.c), a1 = at(0.28), a2 = at(0.72);
      marks += `<text class="mk ${cp}" x="${f(a1.x)}" y="${f(a1.y)}" text-anchor="middle" dominant-baseline="central">${mp}</text>
        <text class="mk ${cq}" x="${f(a2.x)}" y="${f(a2.y)}" text-anchor="middle" dominant-baseline="central">${mq}</text>
        <text class="sc" x="${f(mid.x)}" y="${f(mid.y)}" text-anchor="middle" dominant-baseline="central">${sp}-${sq}</text>`;
    } else {
      marks += `<text class="sc none" x="${f(mid.x)}" y="${f(mid.y)}" text-anchor="middle" dominant-baseline="central">未</text>`;
    }
  }
  const verts = V.map(v => {
    const adv = st.done > 0 && played[v.c] > 0 && rankOf[v.c] <= S.advance;
    return `<circle cx="${f(v.x)}" cy="${f(v.y)}" r="25" fill="${adv ? "var(--accent)" : "var(--tint)"}"/>
      <text class="vt" x="${f(v.x)}" y="${f(v.y)}" text-anchor="middle" dominant-baseline="central" fill="${adv ? "#fff" : "var(--ink)"}">${nm(v.c)}</text>`;
  }).join("");
  return `<svg class="diagram" viewBox="0 0 440 400" role="img" aria-label="${L.name}の対戦図">${lines}${marks}${verts}</svg>`;
}

/* ---------- 順位表 ---------- */
function tableHTML(st) {
  const dr = S.draw;
  const rows = st.rows.map((r, idx) => {
    const adv = st.done > 0 && r.p > 0 && r.rank <= S.advance;
    const where = idx === 0 ? ["決勝へ", "決勝圏"] : ["3位決定戦へ", "3位決定戦圏"];
    const tag = !adv ? "" : r.tie ? '<span class="tag prov">進出圏</span>'
      : st.settled ? `<span class="tag">${where[0]}</span>` : `<span class="tag prov">${where[1]}</span>`;
    const rank = st.done === 0 ? "–" : r.tie ? `${r.rank}<small>同率</small>` : r.rank;
    return `<tr class="${adv ? "adv" : ""}"><td class="l">${rank}</td><td class="l cls">${nm(r.c)}${tag}</td>
      <td>${r.p}</td><td>${r.w}</td>${dr ? `<td>${r.d}</td>` : ""}<td>${r.l}</td><td>${r.p ? pct(r.rate) : "–"}</td>
      <td>${r.gf}</td><td>${r.ga}</td><td class="diff">${sgn(r.diff)}</td></tr>`;
  }).join("");
  return `<div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">組</th><th>試合</th><th>勝</th>${dr ? "<th>分</th>" : ""}<th>負</th><th>勝率</th><th>得点</th><th>失点</th><th>得失点差</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function noticeHTML(st) {
  if (!(st.complete && st.undecided)) return "";
  const L = st.league;
  if (!draft[L.id]) draft[L.id] = st.tied.map(r => r.c);
  const items = draft[L.id].map((c, i) =>
    `<li>${nm(c)}<button type="button" data-act="up" data-l="${L.id}" data-i="${i}">▲</button><button type="button" data-act="down" data-l="${L.id}" data-i="${i}">▼</button></li>`).join("");
  return `<div class="notice"><b>勝率も得失点差も同じクラスがあるため、順位が決まりません。</b>抽選・PK戦などで決めた順（上が上位）に並べて「この順位で確定」を押してください。
    <ol>${items}</ol><button type="button" class="ok" data-act="save" data-l="${L.id}">この順位で確定</button></div>`;
}

function leagueHTML(st) {
  const L = st.league;
  return `<div><div class="lhead"><h2>${L.name}</h2><span>${st.total}試合中 ${st.done}試合 終了${st.complete ? "（全試合終了）" : ""}</span></div>
    ${leagueSVG(L, st)}${tableHTML(st)}${noticeHTML(st)}</div>`;
}

/* ---------- 決勝・3位決定戦 ---------- */
function koHTML(k) {
  const team = (c, pc, src) => {
    if (c) return `<span class="n">${nm(c)}</span>`;
    if (pc) return `<span class="n prov">${nm(pc)}<small>（暫定）</small></span>`;
    return `<span class="n pending">${src}</span>`;
  };
  const rec = k.rec, win = k.winner;
  const note = rec ? (rec.sa === rec.sb ? `<div class="in">同点のため${nm(win)}がPK戦（延長）で勝ち</div>` : "")
    : k.stale ? '<div class="stale">リーグ戦の修正で対戦カードが変わりました。再入力してください。</div>' : "";
  return `<div class="ko"><h3>${k.name}</h3>
    <div class="src">${k.aSrc} ／ ${k.bSrc}</div>
    <div class="r${win && win === k.a ? " w" : ""}">${team(k.a, k.pa, k.aSrc)}<span>${rec ? rec.sa : ""}</span></div>
    <div class="r${win && win === k.b ? " w" : ""}">${team(k.b, k.pb, k.bSrc)}<span>${rec ? rec.sb : ""}</span></div>
    ${note}</div>`;
}
function bracketHTML() {
  const [fin, tp] = KO;
  let html = `<div class="kos">${koHTML(fin)}${koHTML(tp)}</div>`;
  if (fin.winner && tp.winner) {
    html += `<div class="podium"><div><small>優勝</small>${nm(fin.winner)}</div><div><small>準優勝</small>${nm(fin.loser)}</div>
      <div><small>3位</small>${nm(tp.winner)}</div><div><small>4位</small>${nm(tp.loser)}</div></div>`;
  }
  return html;
}

/* ---------- 結果の入力・全試合の結果 ---------- */
function entryList() {
  const lg = MATCHES.ALL.map(m => ({
    id: m.id, a: m.a, b: m.b, label: `第${m.no}試合`, kind: leagueOf(m.a).name, ko: false, ready: true, rec: getRec(m, DATA.results),
  }));
  const ko = KO.map(k => ({
    id: k.id, a: k.a, b: k.b, label: k.name, kind: "決勝・3位決定戦", ko: true, ready: k.ready, rec: k.rec, stale: k.stale, aSrc: k.aSrc, bSrc: k.bSrc,
  }));
  return [...lg, ...ko];
}
// 入力欄の中身：下書きがあればそれ、なければ保存済みの結果
function edOf(m) {
  if (ED[m.id] && ED[m.id].dirty) return ED[m.id];
  const r = m.rec;
  return { sa: r ? r.sa : "", sb: r ? r.sb : "", pk: r && r.sa === r.sb ? r.pk || "" : "" };
}
const isNum = v => v !== "" && v !== null && v !== undefined && Number.isInteger(Number(v));

function entryRow(m) {
  const A = m.a ? nm(m.a) : m.aSrc, B = m.b ? nm(m.b) : m.bSrc;
  const dis = m.ready ? "" : " disabled";
  const e = edOf(m), tie = isNum(e.sa) && isNum(e.sb) && Number(e.sa) === Number(e.sb);
  const r = m.rec, d = r ? r.sa - r.sb : 0;
  const diff = r ? (d === 0 ? "±0" : `${nm(d > 0 ? r.a : r.b)} +${Math.abs(d)}`) : "";
  const inp = s => `<input type="number" inputmode="numeric" min="0" max="999" placeholder="–" id="e-${m.id}-${s}" data-id="${m.id}" data-s="${s}" value="${e[s === "a" ? "sa" : "sb"]}"${dis}>`;
  const pk = m.ko ? `<select id="e-${m.id}-pk" data-id="${m.id}" data-s="pk"${tie ? "" : " hidden"}${dis}>
      <option value="">同点：PK戦（延長）の勝者を選ぶ</option>
      <option value="A"${e.pk === "A" ? " selected" : ""}>${A}の勝ち</option><option value="B"${e.pk === "B" ? " selected" : ""}>${B}の勝ち</option></select>` : "";
  const state = !m.ready ? '<span class="hint">リーグ戦の終了後に入力できます</span>'
    : m.stale ? '<span class="stale">対戦カードが変わりました。再入力してください</span>' : "";
  return `<tr class="${r ? "saved" : "todo"}" data-row="${m.id}"><td class="l">${m.label}</td><td class="l kind">${m.kind}</td>
    <td class="l who">${A}</td><td class="sc">${inp("a")}<span class="dash">−</span>${inp("b")}</td><td class="l who">${B}</td>
    <td class="l pkcell">${pk}</td><td class="diff">${diff}</td>
    <td class="l act"><button type="button" class="rowsave" data-act="entry-save" data-id="${m.id}"${dis}>${r ? "修正を保存" : "保存"}</button>${r ? `<button type="button" class="link" data-act="entry-del" data-id="${m.id}">取消</button>` : ""}
      <div class="rowmsg" id="msg-${m.id}">${state}</div></td></tr>`;
}
function entryHTML() {
  return `<table class="entry-table"><thead><tr><th class="l">試合</th><th class="l">区分</th><th class="l">左</th><th>スコア</th><th class="l">右</th><th class="l"></th><th>得失点差</th><th class="l"></th></tr></thead>
    <tbody>${entryList().map(entryRow).join("")}</tbody></table>`;
}
function renderEntries() {
  const act = document.activeElement && document.activeElement.id;
  $("#en").innerHTML = entryHTML();
  if (act && act.startsWith("e-")) { const el = document.getElementById(act); if (el) el.focus(); }
}

function validate(m, e) {
  const a = Number(e.sa), b = Number(e.sb);
  if (!isNum(e.sa) || !isNum(e.sb) || a < 0 || b < 0 || a > 999 || b > 999) return { err: "両方のスコアを0以上の整数で入力してください" };
  if (a === b) {
    if (m.ko) {
      if (e.pk !== "A" && e.pk !== "B") return { err: "同点です。PK戦（または延長）の勝者を選んでください" };
      return { a, b, pk: e.pk };
    }
    if (!S.draw) return { err: "引き分けは入力できません（勝敗がつくまで行います）" };
  }
  return { a, b, pk: null };
}
function setMsg(id, t) { const el = document.getElementById("msg-" + id); if (el) el.textContent = t; }
function toast(t) {
  const el = $("#toast");
  el.textContent = t; el.classList.add("on");
  setTimeout(() => el.classList.remove("on"), 2400);
}

/* ---------- 画面の更新 ---------- */
function render(force) {
  $("#lg").innerHTML = STS.map(leagueHTML).join("");
  $("#br").innerHTML = bracketHTML();
  // 入力欄は、結果や対戦カードが変わったときだけ作り直す（入力中の文字が消えないように）
  const s = JSON.stringify([Object.keys(DATA.results).sort().map(k => [k, DATA.results[k].sa, DATA.results[k].sb, DATA.results[k].pk]), KO.map(k => [k.a, k.b])]);
  if (force || s !== sig) { sig = s; renderEntries(); }
  const total = MATCHES.ALL.length + KO.length;
  const done = MATCHES.ALL.filter(m => getRec(m, DATA.results)).length + KO.filter(k => k.rec).length;
  $("#progress").textContent = `全${total}試合中 ${done}試合 終了`;
}

async function load(force) {
  if (loading) return;
  loading = true;
  try {
    DATA = await API.load();
    STS = LEAGUES.map(L => standings(L, DATA.results, DATA.overrides));
    KO = bracket(STS, DATA.results);
    render(force);
    $("#upd").textContent = "最終更新 " + new Date().toLocaleTimeString("ja-JP");
    $("#err").textContent = "";
  } catch (e) {
    $("#err").textContent = e.message || "読み込みに失敗しました（通信を確認してください）。前回の表示のままです。";
  }
  loading = false;
  renderNet();
}

function schedule() {
  clearInterval(timer);
  if ($("#auto").checked) timer = setInterval(() => load(), CONFIG.REFRESH_SEC * 1000);
}

/* ---------- 操作 ---------- */
$("#en").addEventListener("input", e => {
  const t = e.target, id = t.dataset && t.dataset.id;
  if (!id) return;
  const m = entryList().find(x => x.id === id);
  const cur = edOf(m);
  const st = ED[id] = { sa: cur.sa, sb: cur.sb, pk: cur.pk, dirty: true };
  if (t.dataset.s === "pk") st.pk = t.value; else st[t.dataset.s === "a" ? "sa" : "sb"] = t.value;
  const pkEl = document.getElementById("e-" + id + "-pk");
  if (pkEl) pkEl.hidden = !(isNum(st.sa) && isNum(st.sb) && Number(st.sa) === Number(st.sb));
  setMsg(id, "");
});

async function saveEntry(id, btn) {
  const m = entryList().find(x => x.id === id);
  if (!m || !m.ready) return;
  const v = validate(m, edOf(m));
  if (v.err) { setMsg(id, v.err); return; }
  btn.disabled = true; setMsg(id, "保存中…");
  try {
    await API.post({ action: "save", record: { id, a: m.a, b: m.b, sa: v.a, sb: v.b, ia: v.a, ib: v.b, games: v.pk ? "PK" + v.pk : "" } });
    delete ED[id];
    await load(true);
    toast(API.pending() ? "この端末に保存しました（通信が戻ると自動送信）" : "保存しました");
  } catch (err) {
    btn.disabled = false; setMsg(id, "保存できませんでした：" + err.message);
  }
}

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]");
  if (b) {
    const act = b.dataset.act;
    if (act === "entry-save") return saveEntry(b.dataset.id, b);
    if (act === "entry-del") {
      const id = b.dataset.id;
      if (!confirm("この試合の結果を取り消しますか？")) return;
      try { await API.post({ action: "delete", id }); delete ED[id]; await load(true); toast("取り消しました"); }
      catch (err) { setMsg(id, "取り消せませんでした：" + err.message); }
      return;
    }
    const l = Number(b.dataset.l), i = Number(b.dataset.i), d = draft[l];
    if (act === "up" && i > 0) { [d[i - 1], d[i]] = [d[i], d[i - 1]]; render(); }
    else if (act === "down" && i < d.length - 1) { [d[i + 1], d[i]] = [d[i], d[i + 1]]; render(); }
    else if (act === "save") {
      b.disabled = true;
      try {
        await API.post({ action: "override", league: l, order: d });
        delete draft[l];
        await load();
      } catch (err) { b.disabled = false; $("#err").textContent = "保存できませんでした：" + err.message; }
    }
    return;
  }
  if (e.target.id === "reset" && confirm("テストデータを全て消します。よろしいですか？")) {
    await API.post({ action: "reset" });
    Object.keys(ED).forEach(k => delete ED[k]);
    load(true);
  }
});
$("#reload").addEventListener("click", () => load());
$("#auto").addEventListener("change", schedule);
mountOfflineTools($("#offline"), () => load(true));

load();
schedule();
