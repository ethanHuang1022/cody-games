import { createShell, sound, clamp, DEBUG } from "../shared/shell.js";

const shell = createShell({
  title: "表情模仿",
  model: "face",
  dim: 0.2,
  help: [
    "🎭 畫面會出現一個<b>表情</b>，盡量做得一模一樣",
    "📊 每題 4 秒，取你做得<b>最像</b>的那一刻計分",
    "📸 每題最像的瞬間會被拍下來，最後一起看！",
    "🙂 開始前會先記住你的自然表情（約 1.5 秒）",
  ],
  hint: "😮 張嘴撐 1 秒即可開始",
  readyText: "準備好了！張嘴撐 1 秒，或按「開始」",
});
const { ctx } = shell;

const avg = (...v) => v.reduce((a, b) => a + b, 0) / v.length;

// 每個表情：一組 [取值函式, 目標值]
const EXPRESSIONS = [
  { name: "驚訝", icon: "😮", terms: [[(b) => b.jawOpen, 0.5], [(b) => b.browInnerUp, 0.5], [(b) => avg(b.eyeWideLeft, b.eyeWideRight), 0.35]] },
  { name: "大笑", icon: "😁", terms: [[(b) => avg(b.mouthSmileLeft, b.mouthSmileRight), 0.7], [(b) => avg(b.eyeSquintLeft, b.eyeSquintRight), 0.3]] },
  { name: "嘟嘴", icon: "😗", terms: [[(b) => b.mouthPucker, 0.7]] },
  { name: "生氣", icon: "😠", terms: [[(b) => avg(b.browDownLeft, b.browDownRight), 0.5], [(b) => avg(b.noseSneerLeft, b.noseSneerRight), 0.25]] },
  { name: "眨一隻眼", icon: "😉", terms: [[(b) => Math.abs(b.eyeBlinkLeft - b.eyeBlinkRight), 0.6]] },
  { name: "鼓腮幫子", icon: "🐡", terms: [[(b) => b.cheekPuff, 0.3], [(b) => b.mouthClose ?? 0, 0.1]] },
  { name: "歪嘴笑", icon: "😏", terms: [[(b) => Math.max(b.mouthLeft, b.mouthRight), 0.4], [(b) => Math.max(b.mouthSmileLeft, b.mouthSmileRight), 0.3]] },
  { name: "難過", icon: "😢", terms: [[(b) => avg(b.mouthFrownLeft, b.mouthFrownRight), 0.35], [(b) => b.browInnerUp, 0.35]] },
];
const ROUND_TIME = 4;
const PREP = 1; // 前 1 秒只顯示題目不計分

let state = "menu"; // menu | calib | playing | review
let calibT = 0;
let calibSamples = [];
let base = {};
let shapes = null;
let order = [];
let round = 0;
let roundT = 0;
let current = 0; // 目前相似度
let peak = 0;
let results = [];
let reviewT = 0;
const snap = document.createElement("canvas");
snap.width = 200;
snap.height = 150;

const sfx = {
  tick: () => sound.tone(660, { dur: 0.06, vol: 0.12 }),
  shutter: () => sound.noise({ dur: 0.08, vol: 0.3, freq: 3000, type: "highpass" }),
};

let spaceDown = false;
if (DEBUG) {
  window.addEventListener("keydown", (e) => e.code === "Space" && (spaceDown = true));
  window.addEventListener("keyup", (e) => e.code === "Space" && (spaceDown = false));
}

function start() {
  state = "calib";
  calibT = 0;
  calibSamples = [];
  shell.hideMenu();
}
shell.onStart(start);

function beginGame() {
  // 自然表情的基準值：計分時扣掉，臉型天生嘴角上揚的人也公平
  base = {};
  for (const s of calibSamples) for (const k in s) base[k] = (base[k] ?? 0) + s[k] / calibSamples.length;
  order = [...EXPRESSIONS].sort(() => Math.random() - 0.5);
  round = 0;
  results = [];
  sound.sfx.start();
  beginRound();
}

function beginRound() {
  state = "playing";
  roundT = 0;
  peak = 0;
  lastSec = 99;
}
let lastSec = 99;

function similarity(expr) {
  if (DEBUG) return spaceDown ? 0.9 : 0.1;
  if (!shapes) return 0;
  const baseShapes = new Proxy(base, { get: (o, k) => o[k] ?? 0 });
  const scores = expr.terms.map(([f, target]) => {
    const b = clamp(f(baseShapes), 0, target * 0.6);
    return clamp((f(shapes) - b) / (target - b), 0, 1);
  });
  return avg(...scores);
}

function takeSnapshot() {
  const v = shell.video;
  const g = snap.getContext("2d");
  if (v.readyState < 2) {
    g.fillStyle = "#333";
    g.fillRect(0, 0, snap.width, snap.height);
    return;
  }
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const cw = vh * (snap.width / snap.height);
  g.save();
  g.translate(snap.width, 0);
  g.scale(-1, 1);
  g.drawImage(v, (vw - cw) / 2, 0, cw, vh, 0, 0, snap.width, snap.height);
  g.restore();
}

function update(dt) {
  const expr = order[round];
  roundT += dt;
  current = similarity(expr);
  const sec = Math.ceil(ROUND_TIME - roundT);
  if (sec !== lastSec && sec <= 3) {
    lastSec = sec;
    sfx.tick();
  }
  if (roundT > PREP && current > peak) {
    peak = current;
    takeSnapshot();
  }
  if (roundT >= ROUND_TIME) {
    if (peak === 0) takeSnapshot();
    results.push({ expr, score: Math.round(peak * 100), img: snap.toDataURL("image/jpeg", 0.8) });
    sfx.shutter();
    if (peak >= 0.8) sound.sfx.calibDone();
    state = "review";
    reviewT = 1.5;
  }
}

function finish() {
  state = "menu";
  const total = results.reduce((a, r) => a + r.score, 0);
  const best = shell.saveBest(total);
  const cards = results
    .map(
      (r) =>
        `<figure style="display:inline-block;margin:4px;text-align:center">` +
        `<img src="${r.img}" width="120" height="90" style="border-radius:8px;display:block" alt="${r.expr.name}">` +
        `<figcaption>${r.expr.icon} ${r.score}</figcaption></figure>`,
    )
    .join("");
  shell.showMenu({
    title: "表情大師！",
    status: `總分 ${total} / ${results.length * 100}　最高 ${best}`,
    result: `<div style="max-width:560px">${cards}</div>`,
  });
  sound.sfx.gameOver();
}

function readFace() {
  const cats = shell.result?.faceBlendshapes?.[0]?.categories;
  if (!cats) {
    shapes = null;
    return;
  }
  shapes = {};
  for (const c of cats) shapes[c.categoryName] = c.score;
}

function draw() {
  const { W, H, S } = shell;
  const expr = order[round];
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, 150 * S);
  shell.text(expr.icon, W / 2 - 120 * S, 72 * S, { size: 90 });
  shell.text(expr.name, W / 2 + 40 * S, 52 * S, { size: 40, bold: true, align: "left" });
  shell.text(`第 ${round + 1} / ${order.length} 題`, W / 2 + 40 * S, 102 * S, { size: 18, align: "left" });

  const bw = 320 * S;
  const y = H - 70 * S;
  shell.bar(W / 2 - bw / 2, y, bw, 18 * S, current, current >= 0.8 ? "#5be37d" : "#ffd447");
  ctx.fillStyle = "#fff";
  ctx.fillRect(W / 2 - bw / 2 + bw * peak - 1, y - 4 * S, 3, 26 * S);
  shell.text(`相似度 ${Math.round(current * 100)}%　·　最高 ${Math.round(peak * 100)}%`, W / 2, y - 22 * S, { size: 18 });
  const left = Math.max(0, ROUND_TIME - roundT);
  shell.text(roundT < PREP ? "準備…" : left.toFixed(1), W - 70 * S, 200 * S, { size: 40, bold: true });
  if (!DEBUG && !shapes) shell.text("找不到臉，請面向鏡頭", W / 2, H / 2, { color: "#ffb3b3", size: 26 });
}

shell.loop((dt) => {
  shell.detect();
  readFace();

  if (state === "calib") {
    if (shapes || DEBUG) {
      calibT += dt;
      if (shapes) calibSamples.push({ ...shapes });
      if (calibT >= 1.5) beginGame();
    }
  } else if (state === "playing") update(dt);
  else if (state === "review") {
    reviewT -= dt;
    if (reviewT <= 0) {
      round += 1;
      if (round < order.length) beginRound();
      else finish();
    }
  } else shell.updateHoldStart((shapes?.jawOpen ?? 0) > 0.5, dt, "保持張嘴");

  shell.drawVideo();
  if (state === "calib") shell.banner("放鬆，保持自然表情", "正在記住你的臉…", calibT / 1.5);
  if (state === "playing") draw();
  if (state === "review") {
    const r = results[results.length - 1];
    shell.banner(`${r.expr.icon} ${r.score} 分`, r.score >= 80 ? "太像了！" : r.score >= 50 ? "不錯喔！" : "再誇張一點！");
  }
});

shell.init();
