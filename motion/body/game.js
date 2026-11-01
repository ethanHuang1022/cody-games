import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import * as sound from "../shared/sound.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// 網址加上 ?debug 可以不用鏡頭測試：空白鍵 = 做一次目前的動作
const DEBUG = new URLSearchParams(location.search).has("debug");

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const startBtn = document.getElementById("start");
const muteBtn = document.getElementById("mute");

let W = 0;
let H = 0;
let S = 1;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S = Math.min(W, H) / 700;
}
window.addEventListener("resize", resize);
resize();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (prev, next, a = 0.5) => prev + (next - prev) * a;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function angle(a, b, c) {
  const v1 = Math.atan2(a.y - b.y, a.x - b.x);
  const v2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(((v1 - v2) * 180) / Math.PI);
  return d > 180 ? 360 - d : d;
}

// ---------- 輸入：除錯按鍵與音效 ----------

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    if (DEBUG && !e.repeat) debugRep = true;
  }
  if (e.code === "KeyM" && !e.repeat) toggleMute();
  sound.unlockAudio();
});
window.addEventListener("pointerdown", () => sound.unlockAudio());

function updateMuteBtn() {
  muteBtn.textContent = sound.isMuted() ? "🔇" : "🔊";
}
function toggleMute() {
  sound.toggleMute();
  updateMuteBtn();
}
muteBtn.addEventListener("click", toggleMute);
updateMuteBtn();

// ---------- 姿勢偵測 ----------

// MediaPipe Pose 關節編號（左右是玩家自己的左右；畫面是鏡像，所以玩家的左手會出現在畫面左邊）
const J = {
  nose: 0,
  ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
  lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28,
};
const BODY_POINTS = [J.ls, J.rs, J.lh, J.rh, J.lk, J.rk, J.la, J.ra];
const BONES = [
  [J.ls, J.rs], [J.ls, J.le], [J.le, J.lw], [J.rs, J.re], [J.re, J.rw],
  [J.ls, J.lh], [J.rs, J.rh], [J.lh, J.rh],
  [J.lh, J.lk], [J.lk, J.la], [J.rh, J.rk], [J.rk, J.ra],
];

let landmarker = null;
let lastVideoTime = -1;
let pts = null; // 平滑後的關節點（0~1 影像座標）
let pose = null; // 由關節點算出的身體幾何
let debugRep = false;

function readPose() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  const lm = res.landmarks?.[0];
  if (!lm) {
    pts = null;
    pose = null;
    return;
  }
  if (!pts) pts = lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 }));
  else {
    lm.forEach((p, i) => {
      pts[i].x = smooth(pts[i].x, p.x, 0.6);
      pts[i].y = smooth(pts[i].y, p.y, 0.6);
      pts[i].v = p.visibility ?? 1;
    });
  }

  // 換成長寬比正確的座標，角度和距離才準
  const aspect = video.videoWidth / video.videoHeight || 4 / 3;
  const g = (i) => ({ x: pts[i].x * aspect, y: pts[i].y });
  const sh = mid(g(J.ls), g(J.rs));
  const hip = mid(g(J.lh), g(J.rh));
  const full = BODY_POINTS.every((i) => pts[i].v > 0.5 && pts[i].y > -0.02 && pts[i].y < 1.02);

  pose = {
    g,
    sh,
    hip,
    T: Math.max(0.05, dist(sh, hip)), // 軀幹長度：所有距離都除以它，跟站多遠無關
    sw: Math.max(0.03, dist(g(J.ls), g(J.rs))), // 肩寬
    full,
  };
}

// ---------- 動作判定 ----------
// 每個動作回傳 0~1 的「完成度」；到 0.9 算做到一次，回到 0.25 以下才能再算下一次

let kneeBase = 0.95; // 站直時膝蓋在髖部下方多少個軀幹長，開場站位時量

const MOVES = {
  squat: {
    name: "深蹲",
    icon: "🏋️",
    color: "#ff7b54",
    kcal: 0.32,
    progress(p) {
      const a = (angle(p.g(J.lh), p.g(J.lk), p.g(J.la)) + angle(p.g(J.rh), p.g(J.rk), p.g(J.ra))) / 2;
      return clamp((160 - a) / (160 - 115), 0, 1);
    },
  },
  jack: {
    name: "開合跳",
    icon: "🤸",
    color: "#ffd447",
    kcal: 0.2,
    progress(p) {
      const wristY = (p.g(J.lw).y + p.g(J.rw).y) / 2;
      const arms = clamp((p.sh.y - wristY) / (0.6 * p.T), 0, 1);
      const legs = clamp((dist(p.g(J.la), p.g(J.ra)) / p.sw - 0.9) / (1.5 - 0.9), 0, 1);
      return arms * 0.6 + legs * 0.4;
    },
  },
  punchL: {
    name: "左手側拳",
    icon: "👈",
    color: "#59c8ff",
    kcal: 0.1,
    progress: (p) => punch(p, J.ls, J.lw),
  },
  punchR: {
    name: "右手側拳",
    icon: "👉",
    color: "#b17cff",
    kcal: 0.1,
    progress: (p) => punch(p, J.rs, J.rw),
  },
  knee: {
    name: "抬膝",
    icon: "🦵",
    color: "#5be37d",
    kcal: 0.15,
    progress(p) {
      // 支撐腳要打直，避免深蹲時膝蓋位置被誤判成抬膝
      const lift = (k, h, kk, a) =>
        angle(p.g(h), p.g(kk), p.g(a)) > 150 ? (kneeBase - (p.g(k).y - p.hip.y) / p.T) / (kneeBase - 0.35) : 0;
      return clamp(Math.max(lift(J.lk, J.rh, J.rk, J.ra), lift(J.rk, J.lh, J.lk, J.la)), 0, 1);
    },
  },
};

// 手臂往側邊打直、大約在肩膀高度
function punch(p, shoulder, wrist) {
  const s = p.g(shoulder);
  const w = p.g(wrist);
  if (Math.abs(w.y - s.y) / p.T > 0.45) return 0;
  return clamp((Math.abs(w.x - s.x) / p.T - 0.35) / (0.8 - 0.35), 0, 1);
}

const armed = {}; // 每個動作是否已回到起始姿勢、可以算下一次
for (const k in MOVES) armed[k] = true;

function detectRep(move) {
  const p = pose?.full ? MOVES[move].progress(pose) : 0;
  let rep = false;
  for (const k in MOVES) {
    const v = pose?.full ? MOVES[k].progress(pose) : 0;
    if (armed[k] && v >= 0.9) {
      armed[k] = false;
      if (k === move) rep = true;
    } else if (!armed[k] && v <= 0.25) {
      armed[k] = true;
    }
  }
  if (debugRep) {
    debugRep = false;
    rep = true;
  }
  return { rep, progress: p };
}

const handsUp = () =>
  pose && pts[J.lw].y < pts[J.nose].y && pts[J.rw].y < pts[J.nose].y && pts[J.lw].v > 0.5 && pts[J.rw].v > 0.5;

// ---------- 遊戲狀態 ----------

const MAX_LIVES = 5;
const POSITION_TIME = 2; // 開場站好的秒數

let state = "loading"; // loading | menu | positioning | playing | over
let lives;
let score;
let combo;
let level;
let defeated;
let reps;
let elapsed;
let monster;
let lastMove = null;
let shots;
let sparks;
let floaters;
let shake = 0;
let flash = 0;
let holdUp = 0;
let positionT = 0;
let kneeSamples = [];
let curProgress = 0;
let menuMsg = "";
let best = 0;
try { best = Number(localStorage.getItem("body-hero-best")) || 0; } catch { /* 忽略 */ }

function setStatus(msg) {
  menuMsg = msg;
  statusEl.textContent = msg;
}

function resetGame() {
  lives = MAX_LIVES;
  score = 0;
  combo = 0;
  level = 0;
  defeated = 0;
  elapsed = 0;
  reps = {};
  for (const k in MOVES) reps[k] = 0;
  shots = [];
  sparks = [];
  floaters = [];
  lastMove = null;
  spawnMonster();
}

function spawnMonster() {
  level += 1;
  const choices = Object.keys(MOVES).filter((k) => k !== lastMove);
  const move = choices[Math.floor(Math.random() * choices.length)];
  lastMove = move;
  const hp = Math.min(10, 3 + Math.floor(level / 2));
  const maxTimer = Math.max(4, 9 - level * 0.35);
  monster = { move, hp, maxHp: hp, timer: maxTimer, maxTimer, hurt: 0, dying: 0, enter: 1, t: 0, lastTick: 99 };
  for (const k in MOVES) armed[k] = false; // 新怪物出現時要先回到起始姿勢
}

function beginPositioning() {
  state = "positioning";
  positionT = 0;
  kneeSamples = [];
  overlay.classList.add("hidden");
  resultEl.classList.remove("show");
}

function startPlaying() {
  if (kneeSamples.length) {
    kneeSamples.sort((a, b) => a - b);
    kneeBase = clamp(kneeSamples[Math.floor(kneeSamples.length / 2)], 0.7, 1.3);
  }
  resetGame();
  state = "playing";
  sound.sfx.start();
}

function gameOver() {
  state = "over";
  best = Math.max(best, score);
  try { localStorage.setItem("body-hero-best", String(best)); } catch { /* 忽略 */ }

  const total = Object.values(reps).reduce((a, b) => a + b, 0);
  const kcal = Object.entries(reps).reduce((a, [k, n]) => a + n * MOVES[k].kcal, 0);
  const rows = Object.entries(MOVES)
    .map(([k, m]) => `<tr><td>${m.icon} ${m.name}</td><td>${reps[k]} 次</td></tr>`)
    .join("");
  resultEl.innerHTML =
    `<p>打倒 <b>${defeated}</b> 隻怪物　·　共 <b>${total}</b> 個動作　·　約 <b>${kcal.toFixed(1)}</b> 大卡　·　${Math.floor(elapsed)} 秒</p>` +
    `<table>${rows}</table>`;
  resultEl.classList.add("show");

  overlay.querySelector("h1").textContent = "勇者倒下了！";
  overlay.querySelector(".help").style.display = "none";
  setStatus(`分數 ${score}　最高 ${best}　—　雙手舉高 1 秒再來一次`);
  startBtn.textContent = "再玩一次";
  overlay.classList.remove("hidden");
  holdUp = 0;
  sound.sfx.gameOver();
}

startBtn.addEventListener("click", beginPositioning);

// ---------- 音效 ----------

const bodySfx = {
  rep() {
    sound.noise({ dur: 0.15, vol: 0.25, freq: 2500, to: 600, type: "bandpass" });
    sound.tone(330, { to: 660, type: "triangle", dur: 0.1, vol: 0.18 });
  },
  monsterHurt() {
    sound.tone(300, { to: 120, type: "square", dur: 0.15, vol: 0.15, at: 0.2 });
  },
  defeat() {
    sound.noise({ dur: 0.5, vol: 0.35, freq: 1500, to: 100 });
    sound.arpeggio([659, 784, 988, 1319], 0.07, { type: "triangle", dur: 0.2, vol: 0.2, at: 0 });
  },
  monsterAttack() {
    sound.noise({ dur: 0.45, vol: 0.5, freq: 600, to: 60 });
    sound.tone(200, { to: 55, type: "sawtooth", dur: 0.4, vol: 0.2 });
  },
  tick() {
    sound.tone(1000, { dur: 0.05, vol: 0.1 });
  },
};

// ---------- 遊戲更新 ----------

// 鏡頭影像以 cover 方式鋪滿畫面，回傳關節在螢幕上的位置（鏡像）
function videoRect() {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const sc = Math.max(W / vw, H / vh);
  const dw = vw * sc;
  const dh = vh * sc;
  return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
}
function toScreen(i) {
  const r = videoRect();
  return { x: r.x + (1 - pts[i].x) * r.w, y: r.y + pts[i].y * r.h };
}

const monsterPos = () => ({ x: W * 0.8, y: H * 0.5, r: 110 * S });

function burst(x, y, color, n = 16) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 100 + Math.random() * 300;
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6, color });
  }
}

function floatText(text, x, y, color) {
  floaters.push({ text, x, y, color, life: 1 });
}

function updatePlaying(dt) {
  const m = monster;
  const ok = DEBUG || pose?.full;
  const { rep, progress } = detectRep(m.move);
  curProgress = progress;

  m.t += dt;
  m.enter = Math.max(0, m.enter - dt * 2.5);
  m.hurt = Math.max(0, m.hurt - dt);

  if (m.dying > 0) {
    m.dying -= dt;
    if (m.dying <= 0) spawnMonster();
  } else if (ok) {
    elapsed += dt;

    if (rep) {
      combo += 1;
      const gain = 10 * (1 + Math.floor(combo / 5));
      score += gain;
      reps[m.move] += 1;
      m.timer = Math.min(m.maxTimer, m.timer + 1.2);
      const from = pts ? mid(toScreen(J.ls), toScreen(J.rs)) : { x: W * 0.4, y: H * 0.5 };
      shots.push({ x: from.x, y: from.y, sx: from.x, sy: from.y, t: 0, color: MOVES[m.move].color });
      bodySfx.rep();
      bodySfx.monsterHurt();
    }

    m.timer -= dt;
    const sec = Math.ceil(m.timer);
    if (m.timer < 3 && sec !== m.lastTick) {
      m.lastTick = sec;
      bodySfx.tick();
    }
    if (m.timer <= 0) {
      lives -= 1;
      combo = 0;
      shake = 0.4;
      flash = 0.35;
      m.timer = m.maxTimer;
      m.lastTick = 99;
      bodySfx.monsterAttack();
      if (lives <= 0) {
        gameOver();
        return;
      }
    }
  }

  // 能量球飛向怪物，命中時扣血
  const mp = monsterPos();
  for (const s of shots) {
    s.t += dt / 0.25;
    const e = Math.min(1, s.t);
    s.x = s.sx + (mp.x - s.sx) * e;
    s.y = s.sy + (mp.y - s.sy) * e - Math.sin(e * Math.PI) * 80 * S;
    if (s.t >= 1 && !s.done) {
      s.done = true;
      burst(mp.x, mp.y, s.color);
      if (m.dying <= 0) {
        m.hp -= 1;
        m.hurt = 0.2;
        floatText(`+${10 * (1 + Math.floor(combo / 5))}`, mp.x, mp.y - mp.r, "#fff");
        if (m.hp <= 0) {
          m.dying = 0.7;
          defeated += 1;
          score += 50 * level;
          floatText(`擊敗！+${50 * level}`, mp.x, mp.y - mp.r - 40 * S, MOVES[m.move].color);
          burst(mp.x, mp.y, MOVES[m.move].color, 40);
          bodySfx.defeat();
        }
      }
    }
  }
  shots = shots.filter((s) => !s.done);

  for (const p of sparks) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 400 * dt;
    p.life -= dt;
  }
  sparks = sparks.filter((p) => p.life > 0);
  for (const f of floaters) {
    f.y -= 60 * dt;
    f.life -= dt;
  }
  floaters = floaters.filter((f) => f.life > 0);
}

function updatePositioning(dt) {
  if (!DEBUG && !pose?.full) {
    positionT = 0;
    kneeSamples = [];
    return;
  }
  positionT += dt;
  if (pose) kneeSamples.push(((pose.g(J.lk).y + pose.g(J.rk).y) / 2 - pose.hip.y) / pose.T);
  if (positionT >= POSITION_TIME) startPlaying();
}

// ---------- 繪圖 ----------

function drawVideo() {
  if (video.readyState >= 2) {
    const r = videoRect();
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, W - r.x - r.w, r.y, r.w, r.h);
    ctx.restore();
  } else {
    ctx.fillStyle = "#0d1226";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = "rgba(10, 14, 32, 0.5)";
  ctx.fillRect(0, 0, W, H);
}

function drawSkeleton(color) {
  if (!pts) return;
  ctx.lineCap = "round";
  ctx.lineWidth = 6 * S;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  for (const [a, b] of BONES) {
    if (pts[a].v < 0.4 || pts[b].v < 0.4) continue;
    const p1 = toScreen(a);
    const p2 = toScreen(b);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of [J.nose, ...BODY_POINTS, J.le, J.re, J.lw, J.rw]) {
    if (pts[i].v < 0.4) continue;
    const p = toScreen(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 * S, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawMonster() {
  const m = monster;
  const mv = MOVES[m.move];
  const base = monsterPos();
  let { x, y, r } = base;
  x += m.enter * W * 0.4;
  y += Math.sin(m.t * 3) * 10 * S;
  if (m.hurt > 0) x += (Math.random() - 0.5) * 16 * S;
  const scale = m.dying > 0 ? m.dying / 0.7 : 1;
  ctx.save();
  ctx.globalAlpha = scale;
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // 身體：有尖刺的圓
  ctx.fillStyle = m.hurt > 0 ? "#fff" : mv.color;
  ctx.beginPath();
  const spikes = 12;
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 + m.t * 0.3;
    const rr = i % 2 ? r : r * 1.15;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.beginPath();
  ctx.arc(0, r * 0.15, r * 0.8, 0, Math.PI * 2);
  ctx.fill();

  // 生氣的眼睛和嘴
  for (const side of [-1, 1]) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(side * r * 0.32, -r * 0.15, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(side * r * 0.32 - r * 0.05, -r * 0.12, r * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#222";
    ctx.lineWidth = r * 0.07;
    ctx.beginPath();
    ctx.moveTo(side * r * 0.5, -r * 0.42);
    ctx.lineTo(side * r * 0.15, -r * 0.3);
    ctx.stroke();
  }
  const angry = m.timer < 2 ? 1 : 0.4;
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.ellipse(0, r * 0.35, r * 0.3, r * 0.1 + r * 0.12 * angry, 0, 0, Math.PI * 2);
  ctx.fill();

  // 身上的動作圖示
  ctx.font = `${r * 0.5}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mv.icon, 0, -r * 1.55);
  ctx.restore();

  if (m.dying > 0) return;

  // 血量
  const bw = r * 2;
  const bx = x - r;
  const by = y + r * 1.35;
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(bx, by, bw, 12 * S);
  ctx.fillStyle = "#ff5b5b";
  ctx.fillRect(bx, by, bw * (m.hp / m.maxHp), 12 * S);
  // 攻擊倒數
  const tr = m.timer / m.maxTimer;
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(bx, by + 20 * S, bw, 8 * S);
  ctx.fillStyle = tr < 0.3 ? "#ff5b5b" : "#ffd447";
  ctx.fillRect(bx, by + 20 * S, bw * tr, 8 * S);
  ctx.fillStyle = "#fff";
  ctx.font = `${14 * S}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(`⏱️ ${Math.ceil(m.timer)} 秒後攻擊`, x, by + 34 * S);
}

function drawInstruction() {
  const mv = MOVES[monster.move];
  const cx = W / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = mv.color;
  ctx.font = `bold ${46 * S}px system-ui, sans-serif`;
  ctx.fillText(`${mv.icon} ${mv.name}！`, cx, 52 * S);
  ctx.fillStyle = "#fff";
  ctx.font = `${20 * S}px system-ui, sans-serif`;
  ctx.fillText(`還要 ${Math.max(0, monster.hp)} 下`, cx, 92 * S);

  // 動作完成度，到最右邊就算一下
  const bw = 260 * S;
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(cx - bw / 2, 112 * S, bw, 10 * S);
  ctx.fillStyle = curProgress >= 0.9 ? "#5be37d" : mv.color;
  ctx.fillRect(cx - bw / 2, 112 * S, bw * curProgress, 10 * S);
  ctx.fillStyle = "#fff";
  ctx.fillRect(cx - bw / 2 + bw * 0.9, 108 * S, 2, 18 * S);
}

function drawHud() {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${22 * S}px system-ui, sans-serif`;
  ctx.fillText(`分數 ${score}`, 16, 34 * S);
  ctx.fillText("❤".repeat(lives) + "♡".repeat(MAX_LIVES - lives), 16, 64 * S);
  ctx.font = `${18 * S}px system-ui, sans-serif`;
  ctx.fillText(`第 ${level} 隻　擊敗 ${defeated}`, 16, 92 * S);
  if (combo >= 3) {
    ctx.fillStyle = "#ffd447";
    ctx.font = `bold ${26 * S}px system-ui, sans-serif`;
    ctx.fillText(`${combo} 連擊！`, 16, 126 * S);
  }
}

function drawCenterMessage(title, sub, progress) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, H / 2 - 80 * S, W, 160 * S);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${38 * S}px system-ui, sans-serif`;
  ctx.fillText(title, W / 2, H / 2 - 22 * S);
  ctx.font = `${20 * S}px system-ui, sans-serif`;
  ctx.fillText(sub, W / 2, H / 2 + 22 * S);
  if (progress != null) {
    const bw = 260 * S;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(W / 2 - bw / 2, H / 2 + 50 * S, bw, 10 * S);
    ctx.fillStyle = "#5be37d";
    ctx.fillRect(W / 2 - bw / 2, H / 2 + 50 * S, bw * progress, 10 * S);
  }
}

function drawEffects() {
  for (const s of shots) {
    ctx.fillStyle = s.color;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 20 * S;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 14 * S, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  for (const p of sparks) {
    ctx.globalAlpha = p.life / 0.6;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 5 * S, 5 * S);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.font = `bold ${26 * S}px system-ui, sans-serif`;
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

// ---------- 主迴圈 ----------

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  readPose();

  if (state === "playing") updatePlaying(dt);
  else if (state === "positioning") updatePositioning(dt);
  else if (state === "menu" || state === "over") {
    // 免手操作：雙手舉過頭撐 1 秒就開始
    const was = holdUp > 0;
    holdUp = handsUp() ? holdUp + dt : 0;
    if (holdUp > 0) statusEl.textContent = `保持舉手… ${(1 - holdUp).toFixed(1)}s`;
    else if (was) statusEl.textContent = menuMsg;
    if (holdUp >= 1) beginPositioning();
  }

  if (state === "playing") {
    sound.setMusicSpeed(clamp(1 + level * 0.03, 1, 1.4));
    sound.startMusic();
  } else {
    sound.stopMusic();
  }

  shake = Math.max(0, shake - dt);
  flash = Math.max(0, flash - dt);

  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * 20 * shake * S * 3, (Math.random() - 0.5) * 20 * shake * S * 3);
  drawVideo();

  if (state === "positioning") {
    drawSkeleton(pose?.full ? "#5be37d" : "#ff5b5b");
    if (DEBUG || pose?.full) drawCenterMessage("很好，站著別動", "正在量測你的身形…", positionT / POSITION_TIME);
    else drawCenterMessage("請退後一點", "讓頭到腳都出現在畫面裡", null);
  } else if (state === "playing") {
    drawSkeleton(MOVES[monster.move].color);
    drawMonster();
    drawInstruction();
    drawEffects();
    drawHud();
    if (!DEBUG && !pose?.full) drawCenterMessage("暫停中", "看不到全身，請退後一點", null);
  } else {
    drawSkeleton("rgba(255,255,255,0.6)");
  }
  ctx.restore();

  if (flash > 0) {
    ctx.fillStyle = `rgba(255, 60, 60, ${flash})`;
    ctx.fillRect(0, 0, W, H);
  }

  requestAnimationFrame(loop);
}

// ---------- 初始化 ----------

async function init() {
  requestAnimationFrame(loop);

  if (DEBUG) {
    state = "menu";
    startBtn.disabled = false;
    setStatus("除錯模式：按開始，空白鍵 = 做一次動作");
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.warn("無法開啟鏡頭", err);
    if (!DEBUG) setStatus("無法開啟鏡頭，這個遊戲需要鏡頭才能玩");
    return;
  }

  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
    }
  } catch (err) {
    console.error("模型載入失敗", err);
    if (!DEBUG) setStatus("姿勢模型載入失敗，請檢查網路後重新整理");
    return;
  }

  if (!DEBUG) {
    state = "menu";
    startBtn.disabled = false;
    setStatus("準備好了！雙手舉高過頭 1 秒，或按「開始」");
  }
}

init();
