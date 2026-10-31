"use strict";
/* 本部用：リーグ表・得失点差・決勝・3位決定戦・全結果 */

let DATA = null, STS = [], KO = [], timer = null;
const draft = {}; // 同率の手動並べ替え（作業中）

document.getElementById("t").textContent = CONFIG.EVENT + " " + SP.title;
if (API.local) {
  $("#banner").innerHTML = '<div class="banner">テストモードです。結果はこの端末のブラウザ内にだけ保存され、審判ページと同じブラウザでしか見られません（config.js の API_URL が未設定）。本番のはずなのにこの表示が出る場合は、Ctrl＋Shift＋R で読み込み直してください。<button type="button" class="link" id="reset">テストデータを全て消す</button></div>';
}
$("#rules").textContent =
  `1試合は${SP.games.min}ゲーム、勝ちゲーム数が並べば次のゲーム（最大${SP.games.max}ゲーム）。試合の勝敗は勝ちゲーム数で決まり、並んだときは勝ったゲームの内野差の合計、それも同じならサドンデスで決めます（引き分けなし）。` +
  `得失点は、試合に勝った側が勝ったゲームの内野差（内野の残り人数の差）の合計で、負けた側が勝ったゲームの内野差は数えません。` +
  `順位の決め方：勝点（勝${SP.points.win}・分${SP.points.draw}・負${SP.points.lose}）→ 得失点差。それでも同じときは順位決定サドンデスで決めます。各リーグの1位どうしが決勝、2位どうしが3位決定戦です（全${ALL_LEAGUE_MATCHES.length + 2}試合）。`;

const nm = c => c + "組";

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
    const adv = st.done > 0 && played[v.c] > 0 && rankOf[v.c] <= SP.advance;
    return `<circle cx="${f(v.x)}" cy="${f(v.y)}" r="25" fill="${adv ? "var(--accent)" : "var(--tint)"}"/>
      <text class="vt" x="${f(v.x)}" y="${f(v.y)}" text-anchor="middle" dominant-baseline="central" fill="${adv ? "#fff" : "var(--ink)"}">${nm(v.c)}</text>`;
  }).join("");
  return `<svg class="diagram" viewBox="0 0 440 400" role="img" aria-label="${L.name}の対戦図">${lines}${marks}${verts}</svg>`;
}

/* ---------- 順位表 ---------- */
function tableHTML(st) {
  const rows = st.rows.map((r, idx) => {
    const adv = st.done > 0 && r.p > 0 && r.rank <= SP.advance;
    const where = idx === 0 ? ["決勝へ", "決勝圏"] : ["3位決定戦へ", "3位決定戦圏"];
    const tag = !adv ? "" : r.tie ? '<span class="tag prov">進出圏</span>'
      : st.settled ? `<span class="tag">${where[0]}</span>` : `<span class="tag prov">${where[1]}</span>`;
    const rank = st.done === 0 ? "–" : r.tie ? `${r.rank}<small>同率</small>` : r.rank;
    return `<tr class="${adv ? "adv" : ""}"><td class="l">${rank}</td><td class="l cls">${nm(r.c)}${tag}</td>
      <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.pts}</td>
      <td>${r.gf}</td><td>${r.ga}</td><td class="diff">${sgn(r.diff)}</td></tr>`;
  }).join("");
  return `<div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">組</th><th>試合</th><th>勝</th><th>分</th><th>負</th><th>勝点</th><th>得点</th><th>失点</th><th>得失点差</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function noticeHTML(st) {
  if (!(st.complete && st.undecided)) return "";
  const L = st.league;
  if (!draft[L.id]) draft[L.id] = st.tied.map(r => r.c);
  const items = draft[L.id].map((c, i) =>
    `<li>${nm(c)}<button type="button" data-act="up" data-l="${L.id}" data-i="${i}">▲</button><button type="button" data-act="down" data-l="${L.id}" data-i="${i}">▼</button></li>`).join("");
  return `<div class="notice"><b>勝点も得失点差も同じクラスがあるため、順位決定サドンデスが必要です。</b>下のクラスどうしでサドンデスを行い、勝った順（上が上位）に並べて「この順位で確定」を押してください。
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
  const sa = rec ? rec.sa : "", sb = rec ? rec.sb : "";
  const note = rec ? `<div class="in">${gamesText(rec)}</div>`
    : k.stale ? '<div class="stale">リーグ戦の修正で対戦カードが変わりました。再入力してください。</div>' : "";
  return `<div class="ko"><h3>${k.name}</h3>
    <div class="src">${k.aSrc} ／ ${k.bSrc}</div>
    <div class="r${win && win === k.a ? " w" : ""}">${team(k.a, k.pa, k.aSrc)}<span>${sa}</span></div>
    <div class="r${win && win === k.b ? " w" : ""}">${team(k.b, k.pb, k.bSrc)}<span>${sb}</span></div>
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

/* ---------- 全結果 ---------- */
// 各ゲームの内野の残り人数（左 − 右）。例：5−3 ／ 2−6 ／ 4−1
const tbNote = rec => (rec.tb === "diff" ? "（内野差の合計で決着）" : rec.tb === "sd" ? "（サドンデスで決着）" : "");
const gamesText = rec => (rec.games || []).map((g, i) => `第${i + 1}ゲーム ${g[0]}−${g[1]}`).join("　") +
  (rec.sd ? `　サドンデス ${rec.sd[0]}−${rec.sd[1]}` : "") + tbNote(rec);
const gameList = rec => [...(rec.games || []).map(g => g[0] + "−" + g[1]), ...(rec.sd ? ["サドンデス " + rec.sd[0] + "−" + rec.sd[1]] : [])];
function resultsHTML() {
  const row = (no, kind, a, b, rec, srcA, srcB, winner) => {
    const A = a ? nm(a) : srcA, B = b ? nm(b) : srcB;
    const wa = winner === a && a ? "w" : "", wb = winner === b && b ? "w" : "";
    if (!rec) {
      return `<tr class="todo"><td class="l">${no}</td><td class="l">${kind}</td><td class="l">${A}</td><td>未実施</td><td class="l">${B}</td><td></td><td></td></tr>`;
    }
    const d = rec.ia - rec.ib;
    const diff = d === 0 ? "±0" : `${nm(d > 0 ? rec.a : rec.b)} +${Math.abs(d)}`;
    return `<tr><td class="l">${no}</td><td class="l">${kind}</td>
      <td class="l ${wa}"><b>${A}</b></td><td><b>${rec.sa} − ${rec.sb}</b></td><td class="l ${wb}"><b>${B}</b></td>
      <td class="l games">${gameList(rec).join("　／　")}${tbNote(rec)}</td><td class="diff">${diff}</td></tr>`;
  };
  // 勝者は太字・赤で表示。見出しは対戦カードを左右で並べる
  const body = [
    ...ALL_LEAGUE_MATCHES.map(m => {
      const rec = getRec(m, DATA.results);
      const w = rec ? (outcome(rec) === "A" ? m.a : outcome(rec) === "B" ? m.b : null) : null;
      return row(`第${m.no}試合`, leagueOf(m.a).name, m.a, m.b, rec, "", "", w);
    }),
    ...KO.map(k => row(k.name, "決勝・3位決定戦", k.a, k.b, k.rec, k.aSrc, k.bSrc, k.winner)),
  ].join("");
  return `<table><thead><tr><th class="l">試合</th><th class="l">区分</th><th class="l">左</th><th>ゲーム</th><th class="l">右</th><th class="l">各ゲームの内野の残り（左−右）</th><th>得失点差</th></tr></thead><tbody>${body}</tbody></table>`;
}

function render() {
  $("#lg").innerHTML = STS.map(leagueHTML).join("");
  $("#br").innerHTML = bracketHTML();
  $("#rs").innerHTML = resultsHTML();
  const total = ALL_LEAGUE_MATCHES.length + KO.length;
  const done = ALL_LEAGUE_MATCHES.filter(m => getRec(m, DATA.results)).length + KO.filter(k => k.rec).length;
  $("#progress").textContent = `全${total}試合中 ${done}試合 終了`;
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    DATA = await API.load();
    STS = LEAGUES.map(L => standings(L, DATA.results, DATA.overrides));
    KO = bracket(STS, DATA.results);
    render();
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
  if ($("#auto").checked) timer = setInterval(load, CONFIG.REFRESH_SEC * 1000);
}

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]");
  if (b) {
    const l = Number(b.dataset.l), i = Number(b.dataset.i), d = draft[l];
    if (b.dataset.act === "up" && i > 0) { [d[i - 1], d[i]] = [d[i], d[i - 1]]; render(); }
    else if (b.dataset.act === "down" && i < d.length - 1) { [d[i + 1], d[i]] = [d[i], d[i + 1]]; render(); }
    else if (b.dataset.act === "save") {
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
    load();
  }
});
$("#reload").addEventListener("click", load);
mountOfflineTools($("#offline"), load);
$("#auto").addEventListener("change", schedule);

load();
schedule();
