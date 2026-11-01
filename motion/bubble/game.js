import { createShell, sound, rand, DEBUG } from "../shared/shell.js";

const shell = createShell({
  title: "泡泡拍拍",
  model: null, // 不用 AI：比較前後兩張畫面的差異來偵測動作
  dim: 0.25,
  help: [
    "🫧 泡泡從下面飄上來，<b>在泡泡的位置揮手</b>就能拍破",
    "🟡 金泡泡 +30、一般泡泡 +10、💣 紅色炸彈 −20（別碰！）",
    "✨ 畫面上亮起的格子是偵測到動作的地方",
    "⏱️ 限時 60 秒，任何電腦都跑得動（不需要 AI 模型）",
  ],
  hint: "👋 對著鏡頭大力揮手 1 秒即可開始",
  readyText: "準備好了！大力揮手 1 秒，或按「開始」",
});
const { ctx } = shell;

const GW = 64; // 動作偵測格數（寬）
const GH = 36;
const DIFF = 32; // 亮度差超過多少算有動
const GAME_TIME = 60;

const small = document.createElement("canvas");
small.width = GW;
small.height = GH;
const sctx = small.getContext("2d", { willReadFrequently: true });
let prev = null;
const motion = new Float32Array(GW * GH); // 0~1，會慢慢衰減，視覺上比較順
let motionAmount = 0;

let state = "menu";
let bubbles = [];
let spawnT = 0;
let timeLeft = 0;
let score = 0;
let popped = 0;
let bombs = 0;
let shake = 0;

// 除錯模式：滑鼠移動會產生「動作」
let mouse = null;
if (DEBUG) window.addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }));

const sfx = {
  pop: (gold) => {
    sound.noise({ dur: 0.06, vol: 0.3, freq: 2500, type: "bandpass" });
    sound.tone(gold ? 1320 : 880, { to: gold ? 1760 : 1200, type: "sine", dur: 0.1, vol: 0.18 });
  },
  bomb() {
    sound.noise({ dur: 0.5, vol: 0.5, freq: 900, to: 80 });
    sound.tone(120, { to: 40, type: "square", dur: 0.35, vol: 0.2 });
  },
};

function start() {
  state = "playing";
  bubbles = [];
  spawnT = 0;
  timeLeft = GAME_TIME;
  score = 0;
  popped = 0;
  bombs = 0;
  shell.fx.clear();
  shell.hideMenu();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  shell.showMenu({
    title: "時間到！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>拍破 <b>${popped}</b> 顆泡泡　·　碰到炸彈 <b>${bombs}</b> 次</p>`,
  });
  sound.sfx.gameOver();
}
shell.onStart(start);

// 畫面格 (gx, gy) 對應的螢幕矩形；格子已經是鏡像後的座標
function cellRect(gx, gy) {
  const r = shell.videoRect();
  return { x: r.x + (gx / GW) * r.w, y: r.y + (gy / GH) * r.h, w: r.w / GW, h: r.h / GH };
}

function updateMotion() {
  for (let i = 0; i < motion.length; i++) motion[i] *= 0.6;
  const v = shell.video;
  if (v.readyState >= 2) {
    // 縮小並鏡像，跟玩家看到的方向一致
    sctx.save();
    sctx.translate(GW, 0);
    sctx.scale(-1, 1);
    sctx.drawImage(v, 0, 0, GW, GH);
    sctx.restore();
    const data = sctx.getImageData(0, 0, GW, GH).data;
    const gray = new Uint8Array(GW * GH);
    for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10;
    if (prev) for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i] - prev[i]) > DIFF) motion[i] = 1;
    prev = gray;
  }
  if (mouse) {
    const r = shell.videoRect();
    const gx = Math.floor(((mouse.x - r.x) / r.w) * GW);
    const gy = Math.floor(((mouse.y - r.y) / r.h) * GH);
    for (let y = gy - 2; y <= gy + 2; y++) for (let x = gx - 2; x <= gx + 2; x++) if (x >= 0 && y >= 0 && x < GW && y < GH) motion[y * GW + x] = 1;
  }
  let sum = 0;
  for (let i = 0; i < motion.length; i++) if (motion[i] > 0.9) sum++;
  motionAmount = sum / motion.length;
}

// 泡泡範圍內有動作的格子比例
function motionIn(b) {
  const r = shell.videoRect();
  const x0 = Math.floor(((b.x - b.r - r.x) / r.w) * GW);
  const x1 = Math.ceil(((b.x + b.r - r.x) / r.w) * GW);
  const y0 = Math.floor(((b.y - b.r - r.y) / r.h) * GH);
  const y1 = Math.ceil(((b.y + b.r - r.y) / r.h) * GH);
  let n = 0;
  let m = 0;
  for (let y = Math.max(0, y0); y < Math.min(GH, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(GW, x1); x++) {
      n++;
      if (motion[y * GW + x] > 0.9) m++;
    }
  }
  return n ? m / n : 0;
}

function spawn() {
  const { W, H, S } = shell;
  const roll = Math.random();
  const type = roll < 0.15 ? "bomb" : roll < 0.3 ? "gold" : "normal";
  bubbles.push({
    type,
    x: rand(0.08, 0.92) * W,
    y: H + 60 * S,
    r: (type === "gold" ? rand(28, 36) : rand(38, 56)) * S,
    vy: -(type === "gold" ? rand(160, 220) : rand(90, 150)) * S,
    t: Math.random() * 10,
    grace: 0.3, // 剛出現時不判定，避免一出場就被背景雜訊打破
  });
}

function update(dt) {
  const { S } = shell;
  timeLeft -= dt;
  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = rand(0.25, 0.6);
    spawn();
  }
  for (const b of bubbles) {
    b.t += dt;
    b.grace -= dt;
    b.y += b.vy * dt;
    b.x += Math.sin(b.t * 2) * 30 * S * dt;
    if (b.grace > 0 || b.y > shell.H - b.r * 0.5) continue;
    if (motionIn(b) > 0.18) {
      b.dead = true;
      if (b.type === "bomb") {
        score = Math.max(0, score - 20);
        bombs += 1;
        shake = 0.35;
        shell.fx.burst(b.x, b.y, "#ff5b5b", 30, 450);
        shell.fx.text("−20", b.x, b.y, "#ff8080");
        sfx.bomb();
      } else {
        const gain = b.type === "gold" ? 30 : 10;
        score += gain;
        popped += 1;
        shell.fx.burst(b.x, b.y, b.type === "gold" ? "#ffd447" : "#bfe9ff", 14, 250);
        shell.fx.text(`+${gain}`, b.x, b.y, "#fff");
        sfx.pop(b.type === "gold");
      }
    }
  }
  bubbles = bubbles.filter((b) => !b.dead && b.y > -b.r * 2);
  if (timeLeft <= 0) end();
}

function drawMotion() {
  ctx.fillStyle = "rgba(120, 220, 255, 0.25)";
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const m = motion[y * GW + x];
      if (m < 0.3) continue;
      const c = cellRect(x, y);
      ctx.globalAlpha = m;
      ctx.fillRect(c.x, c.y, c.w, c.h);
    }
  }
  ctx.globalAlpha = 1;
}

function drawBubble(b) {
  const S = shell.S;
  if (b.type === "bomb") {
    ctx.fillStyle = "#d63c3c";
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + b.t;
      const rr = i % 2 ? b.r * 0.8 : b.r;
      ctx.lineTo(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr);
    }
    ctx.fill();
    shell.text("💣", b.x, b.y, { size: (b.r / S) * 0.9 });
    return;
  }
  const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.1, b.x, b.y, b.r);
  if (b.type === "gold") {
    g.addColorStop(0, "rgba(255,255,220,0.95)");
    g.addColorStop(1, "rgba(255,200,40,0.7)");
  } else {
    g.addColorStop(0, "rgba(255,255,255,0.7)");
    g.addColorStop(0.7, "rgba(160,220,255,0.25)");
    g.addColorStop(1, "rgba(200,170,255,0.6)");
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2 * S;
  ctx.stroke();
}

shell.loop((dt) => {
  updateMotion();
  if (state === "playing") update(dt);
  else shell.updateHoldStart(motionAmount > 0.08, dt, "繼續揮手");
  shell.fx.update(dt);
  shake = Math.max(0, shake - dt);

  const { S } = shell;
  ctx.save();
  if (shake > 0) ctx.translate(rand(-12, 12) * shake, rand(-12, 12) * shake);
  shell.drawVideo();
  drawMotion();
  if (state === "playing") {
    for (const b of bubbles) drawBubble(b);
    shell.fx.draw();
    shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
    shell.text(`⏱️ ${Math.max(0, Math.ceil(timeLeft))}`, 16, 60 * S, { align: "left" });
  }
  ctx.restore();
});

shell.init();
