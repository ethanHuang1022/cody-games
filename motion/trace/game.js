import { createShell, sound, dist, smooth, DEBUG, HAND, fingerUp, isOpenPalm } from "../shared/shell.js";

const shell = createShell({
  title: "空中描圖",
  model: "hand",
  dim: 0.55,
  help: [
    "☝️ <b>只伸出食指</b>就是下筆，伸出兩根以上手指就是提筆",
    "✏️ 沿著畫面上的虛線描出形狀，描到 95% 會自動進入下一題",
    "🎯 分數看<b>覆蓋率</b>（描到多少）和<b>準確度</b>（有沒有畫歪）",
    "⏱️ 每題 15 秒，共 5 題",
  ],
  hint: "✋ 張開手掌撐 1 秒即可開始",
  readyText: "準備好了！張開手掌撐 1 秒，或按「開始」",
});
const { ctx } = shell;

const ROUNDS = 5;
const ROUND_TIME = 15;
const SAMPLES = 240;

// 形狀：回傳 t∈[0,1) 的點，座標約在 [-1, 1]
const SHAPES = {
  圓形: (t) => ({ x: Math.cos(t * Math.PI * 2), y: Math.sin(t * Math.PI * 2) }),
  愛心: (t) => {
    const a = t * Math.PI * 2;
    return { x: (16 * Math.sin(a) ** 3) / 17, y: -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17 };
  },
  三角形: polygon([[0, -1], [0.95, 0.75], [-0.95, 0.75]]),
  正方形: polygon([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]),
  星星: polygon(
    Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 0.42 : 1;
      return [Math.cos(a) * r, Math.sin(a) * r];
    }),
  ),
  閃電: polygon([[-0.3, -1], [0.45, -1], [0.05, -0.15], [0.5, -0.15], [-0.35, 1], [-0.05, 0.1], [-0.5, 0.1]]),
  波浪: (t) => ({ x: t * 2 - 1, y: Math.sin(t * Math.PI * 4) * 0.5 }),
};

// 多邊形依周長平均取點
function polygon(pts) {
  const segs = pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
  const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const total = lens.reduce((a, b) => a + b, 0);
  return (t) => {
    let d = t * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= lens[i]) {
        const [a, b] = segs[i];
        const k = d / lens[i];
        return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k };
      }
      d -= lens[i];
    }
    return { x: pts[0][0], y: pts[0][1] };
  };
}

let state = "menu"; // menu | playing | review
let order = [];
let round = 0;
let timeLeft = 0;
let outline = []; // { x, y, hit }
let strokes = []; // 每一筆是一串點
let penDown = false;
let reviewT = 0;
let results = [];
const pen = { x: 0, y: 0, seen: false };

// 除錯模式：按住滑鼠 = 下筆
let mouseDown = false;
if (DEBUG) {
  window.addEventListener("pointermove", (e) => Object.assign(pen, { x: e.clientX, y: e.clientY, seen: true }));
  window.addEventListener("pointerdown", () => (mouseDown = true));
  window.addEventListener("pointerup", () => (mouseDown = false));
}

const tol = () => Math.min(shell.W, shell.H) * 0.3 * 0.1; // 允許誤差：形狀大小的 10%

function start() {
  order = Object.keys(SHAPES).sort(() => Math.random() - 0.5).slice(0, ROUNDS);
  round = 0;
  results = [];
  shell.hideMenu();
  beginRound();
  sound.sfx.start();
}
shell.onStart(start);

function beginRound() {
  state = "playing";
  timeLeft = ROUND_TIME;
  strokes = [];
  penDown = false;
  const { W, H } = shell;
  const R = Math.min(W, H) * 0.3;
  const fn = SHAPES[order[round]];
  outline = Array.from({ length: SAMPLES }, (_, i) => {
    const p = fn(i / SAMPLES);
    return { x: W / 2 + p.x * R, y: H / 2 + 20 * shell.S + p.y * R, hit: false };
  });
}

function coverage() {
  return outline.filter((p) => p.hit).length / outline.length;
}

function accuracy() {
  const pts = strokes.flat();
  if (!pts.length) return 0;
  const t = tol() * 1.5;
  const good = pts.filter((p) => outline.some((o) => dist(o, p) < t)).length;
  return good / pts.length;
}

function endRound() {
  const cov = coverage();
  const acc = accuracy();
  const score = Math.round(cov * 70 + acc * 30);
  results.push({ name: order[round], cov, acc, score });
  state = "review";
  reviewT = 1.8;
  if (score >= 80) sound.sfx.calibDone();
  else sound.sfx.calibOk();
}

function finish() {
  state = "menu";
  const total = results.reduce((a, r) => a + r.score, 0);
  const best = shell.saveBest(total);
  const rows = results
    .map((r) => `<tr><td>${r.name}</td><td>覆蓋 ${Math.round(r.cov * 100)}%</td><td>準確 ${Math.round(r.acc * 100)}%</td><td>${r.score} 分</td></tr>`)
    .join("");
  shell.showMenu({
    title: "畫完了！",
    status: `總分 ${total} / ${ROUNDS * 100}　最高 ${best}`,
    result: `<table>${rows}</table>`,
  });
  sound.sfx.gameOver();
}

function readPen() {
  if (DEBUG) return mouseDown;
  const h = shell.result?.landmarks?.[0];
  if (!h) {
    pen.seen = false;
    return false;
  }
  const p = shell.toScreen(h[HAND.indexTip]);
  pen.x = pen.seen ? smooth(pen.x, p.x, 0.55) : p.x;
  pen.y = pen.seen ? smooth(pen.y, p.y, 0.55) : p.y;
  pen.seen = true;
  // 只有食指伸直、中指彎曲才算下筆
  return fingerUp(h, HAND.indexTip) && !fingerUp(h, HAND.middleTip);
}

function addPoint(p) {
  const stroke = strokes[strokes.length - 1];
  const last = stroke[stroke.length - 1];
  // 兩點之間補點，快速移動也能連續覆蓋
  const steps = last ? Math.max(1, Math.ceil(dist(last, p) / 6)) : 1;
  for (let i = 1; i <= steps; i++) {
    const q = last ? { x: last.x + ((p.x - last.x) * i) / steps, y: last.y + ((p.y - last.y) * i) / steps } : p;
    stroke.push(q);
    const t = tol();
    for (const o of outline) if (!o.hit && dist(o, q) < t) o.hit = true;
  }
}

function update(dt, down) {
  timeLeft -= dt;
  if (down && pen.seen) {
    if (!penDown) strokes.push([]);
    addPoint({ x: pen.x, y: pen.y });
  }
  penDown = down && pen.seen;
  if (coverage() >= 0.95 || timeLeft <= 0) endRound();
}

function draw() {
  const { W, S } = shell;
  // 目標形狀
  ctx.lineWidth = 6 * S;
  ctx.lineCap = "round";
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (order[round] === "波浪" && i === outline.length - 1) break;
    ctx.strokeStyle = a.hit ? "#5be37d" : i % 4 < 2 ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // 玩家筆跡
  ctx.strokeStyle = "#ffd447";
  ctx.lineWidth = 5 * S;
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x, s[0].y);
    for (const p of s) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  shell.text(`第 ${round + 1} / ${ROUNDS} 題：${order[round]}`, W / 2, 40 * S, { size: 32, bold: true });
  shell.bar(W / 2 - 150 * S, 66 * S, 300 * S, 10 * S, coverage(), "#5be37d");
  shell.text(`覆蓋 ${Math.round(coverage() * 100)}%　·　⏱️ ${Math.max(0, Math.ceil(timeLeft))}`, W / 2, 92 * S, { size: 18 });
}

function drawPen(down) {
  if (!pen.seen) return;
  const S = shell.S;
  ctx.fillStyle = down ? "#ffd447" : "transparent";
  ctx.strokeStyle = down ? "#ffd447" : "#fff";
  ctx.lineWidth = 3 * S;
  ctx.beginPath();
  ctx.arc(pen.x, pen.y, (down ? 8 : 14) * S, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

shell.loop((dt) => {
  shell.detect();
  const down = readPen();
  const hands = shell.result?.landmarks ?? [];

  if (state === "playing") update(dt, down);
  else if (state === "review") {
    reviewT -= dt;
    if (reviewT <= 0) {
      round += 1;
      if (round < ROUNDS) beginRound();
      else finish();
    }
  } else shell.updateHoldStart(hands.some(isOpenPalm), dt, "保持張開手掌");

  shell.drawVideo();
  if (state === "playing" || state === "review") draw();
  if (state === "review") {
    const r = results[results.length - 1];
    shell.banner(`${r.score} 分`, `覆蓋 ${Math.round(r.cov * 100)}%　準確 ${Math.round(r.acc * 100)}%`);
  }
  if (state === "playing") {
    drawPen(down);
    if (!pen.seen) shell.text("把手舉到鏡頭前", shell.W / 2, shell.H - 40 * shell.S, { color: "#ffb3b3" });
  }
});

shell.init();
