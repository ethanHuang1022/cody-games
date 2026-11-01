import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import * as sound from "../shared/sound.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// 表情門檻預設值；開場校正後會換成玩家自己的數值
const DEFAULT_CALIB = {
  jawClosed: 0.12, // 低於此值視為閉嘴
  jawOpen: 0.45, // 高於此值視為全力張嘴
  smileOn: 0.5, // 微笑開護盾
  tiltOffset: 0, // 玩家自然頭部角度（鏡頭擺歪也能抵銷）
};
const CALIB_KEY = "face-flight-calib";
const TILT_DEAD = 5; // 歪頭死區（度）
const TILT_FULL = 20; // 歪頭最大角度（度）

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const mouthBar = document.getElementById("mouth-bar");
const smileBar = document.getElementById("smile-bar");
const tiltBar = document.getElementById("tilt-bar");
const recalibBtn = document.getElementById("recalib");
const calibPanel = document.getElementById("calib");
const calibIcon = document.getElementById("calib-icon");
const calibTitle = document.getElementById("calib-title");
const calibDesc = document.getElementById("calib-desc");
const calibBar = document.getElementById("calib-bar");
const calibDots = [...document.querySelectorAll(".calib-steps span")];

let calib = loadCalib();

function loadCalib() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALIB_KEY));
    if (saved && typeof saved.jawOpen === "number") return { ...DEFAULT_CALIB, ...saved, saved: true };
  } catch { /* 沒存過或無法讀取 */ }
  return { ...DEFAULT_CALIB, saved: false };
}

let W = 0;
let H = 0;
let S = 1; // 依畫面高度縮放的比例

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S = H / 700;
}
window.addEventListener("resize", resize);
resize();

// ---------- 輸入：臉部 + 鍵盤 ----------

const face = { found: false, jaw: 0, smile: 0, tilt: 0 };
const keys = new Set();
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "Space") e.preventDefault();
  if (e.code === "KeyM" && !e.repeat) toggleMute();
  sound.unlockAudio();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("pointerdown", () => sound.unlockAudio());

const muteBtn = document.getElementById("mute");
function updateMuteBtn() {
  muteBtn.textContent = sound.isMuted() ? "🔇" : "🔊";
}
function toggleMute() {
  sound.toggleMute();
  updateMuteBtn();
}
muteBtn.addEventListener("click", toggleMute);
updateMuteBtn();

let landmarker = null;
let lastVideoTime = -1;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (prev, next, a = 0.5) => prev + (next - prev) * a;

function readFace() {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  if (!res.faceBlendshapes?.length) {
    face.found = false;
    face.jaw = smooth(face.jaw, 0);
    face.smile = smooth(face.smile, 0);
    face.tilt = smooth(face.tilt, 0);
    return;
  }

  face.found = true;
  const shapes = {};
  for (const c of res.faceBlendshapes[0].categories) shapes[c.categoryName] = c.score;
  face.jaw = smooth(face.jaw, shapes.jawOpen ?? 0);
  face.smile = smooth(face.smile, ((shapes.mouthSmileLeft ?? 0) + (shapes.mouthSmileRight ?? 0)) / 2);

  // 用兩眼外眼角連線算歪頭角度；畫面是鏡像，往畫面右邊歪 = 正值
  const lm = res.faceLandmarks[0];
  const a = lm[33];
  const b = lm[263];
  const roll = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  face.tilt = smooth(face.tilt, -roll, 0.35);
}

// 把臉部數值和鍵盤合併成遊戲控制量
function getControls() {
  let thrust = clamp((face.jaw - calib.jawClosed) / (calib.jawOpen - calib.jawClosed), 0, 1);
  let shield = face.smile > calib.smileOn;
  const tilt = face.tilt - calib.tiltOffset;
  let t = Math.abs(tilt) < TILT_DEAD ? 0 : tilt;
  let move = clamp((t - Math.sign(t) * TILT_DEAD) / (TILT_FULL - TILT_DEAD), -1, 1);

  if (keys.has("Space") || keys.has("ArrowUp")) thrust = 1;
  if (keys.has("KeyS")) shield = true;
  if (keys.has("ArrowRight")) move = 1;
  if (keys.has("ArrowLeft")) move = -1;

  mouthBar.style.width = `${thrust * 100}%`;
  smileBar.style.width = `${clamp(face.smile, 0, 1) * 100}%`;
  tiltBar.style.left = `calc(${50 + move * 48}% - 2px)`;

  return { thrust, shield, move };
}

// ---------- 遊戲狀態 ----------

const GRAVITY = 900;
const THRUST = 2000;
const MAX_VY = 520;

let state = "loading"; // loading | calibrating | ready | playing | over
let player;
let clouds;
let stars;
let sparks;
let score;
let best = Number(localStorageGet("face-flight-best") || 0);
let lives;
let energy;
let invuln;
let speed;
let elapsed;
let spawnCloud;
let spawnStar;
let holdOpen = 0; // 在選單張嘴計時，用來免手開始
let menuMsg = "";

function setStatus(msg) {
  menuMsg = msg;
  statusEl.textContent = msg;
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* 忽略 */ }
}

// 背景視差星星
const bgStars = Array.from({ length: 120 }, () => ({
  x: Math.random(),
  y: Math.random(),
  z: 0.2 + Math.random() * 0.8,
}));

function reset() {
  player = { x: W * 0.25, y: H * 0.5, vy: 0, flap: 0, shield: false };
  clouds = [];
  stars = [];
  sparks = [];
  score = 0;
  lives = 3;
  energy = 100;
  invuln = 0;
  speed = 260;
  elapsed = 0;
  spawnCloud = 1.2;
  spawnStar = 0.6;
}

function startGame() {
  reset();
  state = "playing";
  overlay.classList.add("hidden");
  sound.sfx.start();
}

function gameOver() {
  state = "over";
  best = Math.max(best, Math.floor(score));
  localStorageSet("face-flight-best", String(best));
  overlay.querySelector("h1").textContent = "墜機了！";
  setStatus(`分數 ${Math.floor(score)}　最高 ${best}　—　張大嘴 1 秒或按按鈕重來`);
  startBtn.textContent = "再玩一次";
  overlay.classList.remove("hidden");
  holdOpen = 0;
  sound.sfx.gameOver();
}

startBtn.addEventListener("click", startGame);

function burst(x, y, color, n = 14) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 80 + Math.random() * 220;
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6, color });
  }
}

function update(dt, c) {
  elapsed += dt;
  speed = 260 + elapsed * 6; // 越飛越快
  score += dt * speed * 0.05;

  // 玩家物理
  player.vy += (GRAVITY - THRUST * c.thrust) * S * dt;
  player.vy = clamp(player.vy, -MAX_VY * S, MAX_VY * S);
  player.y += player.vy * dt;
  player.x = clamp(player.x + c.move * 260 * S * dt, W * 0.12, W * 0.6);
  player.flap += dt * (6 + c.thrust * 18);

  const pr = 18 * S;
  if (player.y < pr) {
    player.y = pr;
    player.vy = 0;
  }
  if (player.y > H - pr) {
    player.y = H - pr;
    player.vy = -420 * S; // 撞地反彈
    hit();
  }

  // 護盾
  const hadShield = player.shield;
  player.shield = c.shield && energy > 0;
  if (player.shield && !hadShield) sound.sfx.shieldOn();
  energy = player.shield ? Math.max(0, energy - 35 * dt) : Math.min(100, energy + 8 * dt);
  invuln = Math.max(0, invuln - dt);

  // 生成雷雲與星星
  spawnCloud -= dt;
  if (spawnCloud <= 0) {
    spawnCloud = Math.max(0.45, 1.4 - elapsed * 0.015) * (0.7 + Math.random() * 0.6);
    const r = (28 + Math.random() * 38) * S;
    clouds.push({ x: W + r * 2, y: r + Math.random() * (H - r * 2), r, t: Math.random() * 10 });
  }
  spawnStar -= dt;
  if (spawnStar <= 0) {
    spawnStar = 0.7 + Math.random() * 0.9;
    stars.push({ x: W + 30, y: 40 * S + Math.random() * (H - 80 * S), t: 0 });
  }

  const dx = speed * S * dt;
  for (const cl of clouds) {
    cl.x -= dx;
    cl.t += dt;
    const d = Math.hypot(cl.x - player.x, cl.y + Math.sin(cl.t * 2) * 8 * S - player.y);
    if (!cl.dead && d < cl.r + pr * 0.8) {
      if (player.shield) {
        cl.dead = true;
        burst(cl.x, cl.y, "#9fd8ff", 20);
        score += 20;
        sound.sfx.zap();
      } else if (invuln <= 0) {
        cl.dead = true;
        burst(cl.x, cl.y, "#ffe066", 20);
        hit();
      }
    }
  }
  for (const st of stars) {
    st.x -= dx;
    st.t += dt;
    if (!st.dead && Math.hypot(st.x - player.x, st.y - player.y) < pr + 16 * S) {
      st.dead = true;
      score += 50;
      energy = Math.min(100, energy + 15);
      burst(st.x, st.y, "#ffd447");
      sound.sfx.star();
    }
  }
  clouds = clouds.filter((o) => !o.dead && o.x > -o.r * 2);
  stars = stars.filter((o) => !o.dead && o.x > -40);

  for (const p of sparks) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  sparks = sparks.filter((p) => p.life > 0);
}

function hit() {
  if (invuln > 0 || player.shield) return;
  lives -= 1;
  invuln = 1.5;
  burst(player.x, player.y, "#ff6b6b", 24);
  sound.sfx.hit();
  if (lives <= 0) gameOver();
}

// ---------- 繪圖 ----------

function drawBackground(dt) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0b1630");
  g.addColorStop(1, "#2a3f7a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const move = state === "playing" ? speed * dt : 30 * dt;
  ctx.fillStyle = "#fff";
  for (const s of bgStars) {
    s.x -= (move * s.z * 0.3) / W;
    if (s.x < 0) s.x += 1;
    ctx.globalAlpha = 0.3 + s.z * 0.6;
    ctx.fillRect(s.x * W, s.y * H, s.z * 2.2, s.z * 2.2);
  }
  ctx.globalAlpha = 1;
}

function drawCloud(cl) {
  const y = cl.y + Math.sin(cl.t * 2) * 8 * S;
  ctx.fillStyle = "#4a4f6b";
  for (const [ox, oy, rr] of [[-0.6, 0.15, 0.6], [0.6, 0.15, 0.6], [0, -0.15, 0.8], [0, 0.25, 0.7]]) {
    ctx.beginPath();
    ctx.arc(cl.x + ox * cl.r, y + oy * cl.r, rr * cl.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 閃電
  if (Math.sin(cl.t * 7) > 0.6) {
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 3 * S;
    ctx.beginPath();
    ctx.moveTo(cl.x, y + cl.r * 0.5);
    ctx.lineTo(cl.x - cl.r * 0.2, y + cl.r * 0.9);
    ctx.lineTo(cl.x + cl.r * 0.1, y + cl.r * 0.9);
    ctx.lineTo(cl.x - cl.r * 0.1, y + cl.r * 1.3);
    ctx.stroke();
  }
}

function drawStar(st) {
  const r = 14 * S * (1 + Math.sin(st.t * 6) * 0.1);
  ctx.save();
  ctx.translate(st.x, st.y);
  ctx.rotate(st.t * 1.5);
  ctx.fillStyle = "#ffd447";
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPlayer(thrust) {
  if (invuln > 0 && Math.floor(invuln * 10) % 2 === 0) return; // 無敵閃爍
  const { x, y } = player;
  const s = S;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(clamp(player.vy / (MAX_VY * S), -1, 1) * 0.5);

  // 尾焰
  if (thrust > 0.05) {
    ctx.fillStyle = `rgba(255, ${140 + Math.random() * 80}, 60, 0.9)`;
    ctx.beginPath();
    ctx.moveTo(-18 * s, -5 * s);
    ctx.lineTo((-18 - 30 * thrust - Math.random() * 8) * s, 0);
    ctx.lineTo(-18 * s, 5 * s);
    ctx.fill();
  }
  // 身體
  ctx.fillStyle = "#ff8a3d";
  ctx.beginPath();
  ctx.ellipse(0, 0, 22 * s, 13 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // 翅膀
  const wing = Math.sin(player.flap) * 9 * s;
  ctx.fillStyle = "#ffc06b";
  ctx.beginPath();
  ctx.moveTo(-6 * s, 0);
  ctx.lineTo(-16 * s, -14 * s - wing);
  ctx.lineTo(6 * s, -2 * s);
  ctx.fill();
  // 眼睛 + 嘴（跟玩家的嘴同步張開）
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(10 * s, -4 * s, 5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(11.5 * s, -4 * s, 2.2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(16 * s, 5 * s, 4 * s, (1 + thrust * 4) * s, 0, 0, Math.PI * 2);
  ctx.fill();

  if (player.shield) {
    ctx.strokeStyle = "rgba(120, 210, 255, 0.85)";
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.arc(0, 0, 32 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(120, 210, 255, 0.15)";
    ctx.fill();
  }
  ctx.restore();
}

function drawHud() {
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${22 * S}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(`分數 ${Math.floor(score)}`, 16, 34 * S);
  ctx.fillText("❤".repeat(lives), 16, 64 * S);

  // 護盾能量
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(16, 78 * S, 140 * S, 10 * S);
  ctx.fillStyle = "#59c8ff";
  ctx.fillRect(16, 78 * S, 140 * S * (energy / 100), 10 * S);

  if (!face.found && landmarker) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffb3b3";
    ctx.fillText("找不到臉，請面向鏡頭", W / 2, 40 * S);
  }
}

// ---------- 開場校正 ----------

const CALIB_PREP = 1.2; // 每步先給玩家準備的秒數
const CALIB_SAMPLE = 1.5; // 每步取樣秒數
const CALIB_STEPS = [
  { key: "neutral", icon: "😐", title: "放鬆、正對鏡頭", desc: "閉上嘴，頭擺正，表情自然" },
  { key: "open", icon: "😮", title: "嘴巴張到最大", desc: "像要咬一大口那樣，撐住不動" },
  { key: "smile", icon: "😄", title: "露齒大笑", desc: "嘴角用力往上，撐住不動" },
];

let cal = null; // 校正進行中的狀態

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function startCalibration() {
  cal = { step: 0, phase: "prep", t: 0, samples: [], results: {}, note: "", fails: 0 };
  state = "calibrating";
  overlay.classList.remove("hidden");
  overlay.classList.add("calibrating");
  calibPanel.hidden = false;
  statusEl.textContent = "";
  showCalibStep();
}

function showCalibStep() {
  const step = CALIB_STEPS[cal.step];
  calibIcon.textContent = step.icon;
  calibTitle.textContent = step.title;
  calibDesc.textContent = cal.note || step.desc;
  calibDots.forEach((d, i) => {
    d.className = i < cal.step ? "done" : i === cal.step ? "active" : "";
  });
}

function updateCalibration(dt) {
  if (!face.found) {
    statusEl.textContent = "找不到臉，請面向鏡頭";
    return; // 暫停計時，等臉回來
  }
  statusEl.textContent = "";
  cal.t += dt;

  if (cal.phase === "prep") {
    calibBar.classList.remove("sampling");
    calibBar.style.width = `${clamp(cal.t / CALIB_PREP, 0, 1) * 100}%`;
    if (cal.t >= CALIB_PREP) {
      cal.phase = "sample";
      cal.t = 0;
      cal.samples = [];
      sound.sfx.calibBeep();
    }
    return;
  }

  cal.samples.push({ jaw: face.jaw, smile: face.smile, tilt: face.tilt });
  calibBar.classList.add("sampling");
  calibBar.style.width = `${clamp(cal.t / CALIB_SAMPLE, 0, 1) * 100}%`;
  if (cal.t < CALIB_SAMPLE) return;

  const key = CALIB_STEPS[cal.step].key;
  const r = {
    jaw: median(cal.samples.map((s) => s.jaw)),
    smile: median(cal.samples.map((s) => s.smile)),
    tilt: median(cal.samples.map((s) => s.tilt)),
  };

  // 表情幅度太小就重做這一步
  const base = cal.results.neutral;
  cal.note = "";
  if (key === "open" && r.jaw - base.jaw < 0.15) cal.note = "嘴巴張得不夠大，再張大一點！";
  if (key === "smile" && r.smile - base.smile < 0.15) cal.note = "笑得不夠明顯，嘴角再往上！";

  // 連續失敗 3 次就直接接受，避免卡關
  if (cal.note && ++cal.fails >= 3) cal.note = "";

  if (!cal.note) {
    cal.results[key] = r;
    cal.step += 1;
    cal.fails = 0;
  }
  cal.phase = "prep";
  cal.t = 0;

  if (cal.step >= CALIB_STEPS.length) {
    finishCalibration();
    sound.sfx.calibDone();
    return;
  }
  if (cal.note) sound.sfx.calibRetry();
  else sound.sfx.calibOk();
  showCalibStep();
}

function finishCalibration() {
  const { neutral, open, smile } = cal.results;
  const jawRange = Math.max(0.1, open.jaw - neutral.jaw);
  const smileRange = Math.max(0.1, smile.smile - neutral.smile);
  calib = {
    jawClosed: neutral.jaw + jawRange * 0.25, // 稍微張一點才開始推進，避免講話誤觸
    jawOpen: neutral.jaw + jawRange * 0.8, // 不用張到極限就有全力推進
    smileOn: neutral.smile + smileRange * 0.55,
    tiltOffset: neutral.tilt,
    saved: true,
  };
  localStorageSet(CALIB_KEY, JSON.stringify(calib));

  cal = null;
  calibPanel.hidden = true;
  overlay.classList.remove("calibrating");
  state = "ready";
  holdOpen = 0;
  setStatus("校正完成！張大嘴 1 秒，或按「開始」");
}

recalibBtn.addEventListener("click", startCalibration);

// ---------- 主迴圈 ----------

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  readFace();
  const c = getControls();

  if (state === "playing") {
    update(dt, c);
  } else if (state === "calibrating") {
    updateCalibration(dt);
  } else if (state === "ready" || state === "over") {
    // 免手操作：張大嘴撐住 1 秒就開始
    const wasHolding = holdOpen > 0;
    holdOpen = c.thrust > 0.8 ? holdOpen + dt : 0;
    if (holdOpen > 0 && landmarker) {
      statusEl.textContent = `保持張嘴… ${(1 - holdOpen).toFixed(1)}s`;
    } else if (wasHolding) {
      statusEl.textContent = menuMsg;
    }
    if (holdOpen >= 1) startGame();
  }

  // 音樂與推進器聲只在遊戲中播放；音效晚一點才解鎖時也會自動補上
  if (state === "playing") {
    sound.setThrust(c.thrust);
    sound.setMusicSpeed(clamp(speed / 260, 1, 1.4));
    sound.startMusic();
  } else {
    sound.setThrust(0);
    sound.stopMusic();
  }

  drawBackground(dt);
  if (state === "playing") {
    clouds.forEach(drawCloud);
    stars.forEach(drawStar);
    drawPlayer(c.thrust);
    for (const p of sparks) {
      ctx.globalAlpha = p.life / 0.6;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, 4 * S, 4 * S);
    }
    ctx.globalAlpha = 1;
    drawHud();
  }

  requestAnimationFrame(loop);
}

// ---------- 初始化 ----------

async function init() {
  requestAnimationFrame(loop);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.warn("無法開啟鏡頭", err);
    setStatus("無法開啟鏡頭，改用鍵盤遊玩");
    state = "ready";
    startBtn.disabled = false;
    return;
  }

  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
  } catch (err) {
    console.error("模型載入失敗", err);
    setStatus("臉部模型載入失敗，改用鍵盤遊玩");
    state = "ready";
    startBtn.disabled = false;
    return;
  }

  startBtn.disabled = false;
  recalibBtn.disabled = false;
  if (calib.saved) {
    // 已有存檔就直接使用，想重做可按「重新校正」
    state = "ready";
    setStatus("準備好了！張大嘴 1 秒，或按「開始」");
  } else {
    startCalibration();
  }
}

init();
