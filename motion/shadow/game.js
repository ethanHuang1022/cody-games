import { createShell, sound, rand, DEBUG } from "../shared/shell.js";

const shell = createShell({
  title: "影子彈珠",
  model: "segment",
  dim: 0.8,
  help: [
    "👤 你的<b>影子</b>就是實體，球碰到會彈開",
    "🏐 用頭、手、身體把球<b>往上頂</b>，別讓它掉到地上",
    "⭐ 讓球撞到星星得分，越往身體方向移動，彈得越用力",
    "💔 球掉到底部 5 次就結束，每 15 秒多一顆球",
  ],
  hint: "🙌 雙手舉高揮一揮撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高揮一揮 1 秒，或按「開始」",
});
const { ctx } = shell;

const GW = 96; // 影子格數
const GH = 54;
const MAX_DROPS = 5;

let grid = new Float32Array(GW * GH); // 0~1，鏡像後的人像遮罩
let prevGrid = new Float32Array(GW * GH);
const shadowCanvas = document.createElement("canvas");
shadowCanvas.width = GW;
shadowCanvas.height = GH;
const sh = shadowCanvas.getContext("2d");
const shadowImg = sh.createImageData(GW, GH);

let state = "menu";
let balls = [];
let stars = [];
let score = 0;
let drops = 0;
let elapsed = 0;
let addBallT = 0;
let topCoverage = 0; // 上半部有影子的比例（用來免手開始）

let mouse = null;
if (DEBUG) window.addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }));

const sfx = {
  bounce: (v) => sound.tone(300 + Math.min(600, v * 0.6), { type: "sine", dur: 0.08, vol: 0.12 }),
  star: () => sound.arpeggio([1047, 1319, 1568], 0.05, { type: "triangle", dur: 0.12, vol: 0.18 }),
  drop: () => sound.tone(300, { to: 80, type: "sawtooth", dur: 0.4, vol: 0.15 }),
};

function start() {
  state = "playing";
  balls = [];
  stars = [];
  score = 0;
  drops = 0;
  elapsed = 0;
  addBallT = 15;
  addBall();
  for (let i = 0; i < 3; i++) addStar();
  shell.fx.clear();
  shell.hideMenu();
  sound.sfx.start();
}
shell.onStart(start);

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  shell.showMenu({
    title: "球都掉光了！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>撐了 <b>${Math.floor(elapsed)}</b> 秒</p>`,
  });
  sound.sfx.gameOver();
}

function addBall() {
  const { W, S } = shell;
  balls.push({ x: rand(0.3, 0.7) * W, y: -30 * S, vx: rand(-80, 80) * S, vy: 0, r: 26 * S, hue: rand(0, 360), cool: 0 });
}

function addStar() {
  const { W, H, S } = shell;
  stars.push({ x: rand(0.1, 0.9) * W, y: rand(0.1, 0.4) * H, r: 26 * S, t: Math.random() * 10 });
}

// 讀取分割遮罩並縮成格子（鏡像）
function readMask() {
  if (!shell.fresh) return;
  const res = shell.result;
  const mask = res?.confidenceMasks?.[0];
  [prevGrid, grid] = [grid, prevGrid];
  grid.fill(0);
  if (mask) {
    const data = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;
    for (let gy = 0; gy < GH; gy++) {
      const my = Math.floor(((gy + 0.5) / GH) * mh);
      for (let gx = 0; gx < GW; gx++) {
        const mx = Math.floor(((GW - 1 - gx + 0.5) / GW) * mw);
        grid[gy * GW + gx] = data[my * mw + mx];
      }
    }
  }
  res?.close?.();
  let top = 0;
  for (let i = 0; i < (GW * GH) / 3; i++) if (grid[i] > 0.5) top++;
  topCoverage = top / ((GW * GH) / 3);
}

function addMouseShadow() {
  if (!mouse) return;
  [prevGrid, grid] = [grid, prevGrid];
  grid.fill(0);
  const r = shell.videoRect();
  const cx = ((mouse.x - r.x) / r.w) * GW;
  const cy = ((mouse.y - r.y) / r.h) * GH;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (Math.hypot(x - cx, (y - cy) * 1.2) < 6) grid[y * GW + x] = 1;
}

function toGrid(x, y) {
  const r = shell.videoRect();
  return { gx: ((x - r.x) / r.w) * GW, gy: ((y - r.y) / r.h) * GH, cw: r.w / GW, ch: r.h / GH, r };
}

function collide(b) {
  const { gx, gy, cw, ch } = toGrid(b.x, b.y);
  const rx = b.r / cw;
  const ry = b.r / ch;
  let nx = 0;
  let ny = 0;
  let hits = 0;
  let fresh = 0; // 這一幀才出現的影子格 = 身體正在往球的方向移動
  for (let y = Math.floor(gy - ry); y <= Math.ceil(gy + ry); y++) {
    for (let x = Math.floor(gx - rx); x <= Math.ceil(gx + rx); x++) {
      if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
      const i = y * GW + x;
      if (grid[i] < 0.5) continue;
      const dx = (gx - (x + 0.5)) * cw;
      const dy = (gy - (y + 0.5)) * ch;
      const d = Math.hypot(dx, dy);
      if (d > b.r) continue;
      nx += dx / (d || 1);
      ny += dy / (d || 1);
      hits++;
      if (prevGrid[i] < 0.5) fresh++;
    }
  }
  if (!hits) return;
  // 球完全埋在影子裡時沒有方向，就往上推
  const len = Math.hypot(nx, ny);
  if (len < 0.01) {
    nx = 0;
    ny = -1;
  } else {
    nx /= len;
    ny /= len;
  }
  // 推出影子
  b.x += nx * b.r * 0.35;
  b.y += ny * b.r * 0.35;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) {
    b.vx -= 1.75 * vn * nx;
    b.vy -= 1.75 * vn * ny;
  }
  // 身體撞過來時額外加力
  const kick = Math.min(1, fresh / 4) * 450 * shell.S;
  b.vx += nx * kick;
  b.vy += ny * kick;
  if (b.cool <= 0) {
    sfx.bounce(Math.abs(vn) + kick);
    b.cool = 0.12;
  }
}

function update(dt) {
  const { W, H, S } = shell;
  elapsed += dt;
  addBallT -= dt;
  if (addBallT <= 0 && balls.length < 3) {
    addBallT = 15;
    addBall();
  }
  for (const b of balls) {
    b.cool -= dt;
    b.vy += 700 * S * dt;
    b.vx *= Math.pow(0.7, dt);
    const sp = Math.hypot(b.vx, b.vy);
    const max = 1400 * S;
    if (sp > max) {
      b.vx *= max / sp;
      b.vy *= max / sp;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    collide(b);
    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * 0.8;
    }
    if (b.x > W - b.r) {
      b.x = W - b.r;
      b.vx = -Math.abs(b.vx) * 0.8;
    }
    if (b.y < b.r && b.vy < 0) {
      b.y = b.r;
      b.vy *= -0.6;
    }
    for (const s of stars) {
      if (!s.hit && Math.hypot(s.x - b.x, s.y - b.y) < s.r + b.r) {
        s.hit = true;
        score += 10;
        shell.fx.burst(s.x, s.y, "#ffd447", 20);
        shell.fx.text("+10", s.x, s.y - 30 * S, "#fff");
        sfx.star();
      }
    }
    if (b.y > H + b.r) {
      b.dead = true;
      drops += 1;
      shell.fx.text("掉了！", b.x, H - 40 * S, "#ff8080");
      sfx.drop();
    }
  }
  balls = balls.filter((b) => !b.dead);
  stars = stars.filter((s) => !s.hit);
  while (stars.length < 3) addStar();
  for (const s of stars) s.t += dt;
  if (drops >= MAX_DROPS) {
    end();
    return;
  }
  if (!balls.length) addBall();
}

function drawShadow() {
  const d = shadowImg.data;
  for (let i = 0; i < grid.length; i++) {
    const m = grid[i];
    d[i * 4] = 90;
    d[i * 4 + 1] = 200;
    d[i * 4 + 2] = 255;
    d[i * 4 + 3] = m > 0.5 ? 200 : m * 120;
  }
  sh.putImageData(shadowImg, 0, 0);
  const r = shell.videoRect();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(shadowCanvas, r.x, r.y, r.w, r.h);
}

function draw() {
  const { S } = shell;
  for (const s of stars) {
    const k = 1 + Math.sin(s.t * 4) * 0.1;
    shell.text("⭐", s.x, s.y, { size: (s.r / S) * 1.6 * k });
  }
  for (const b of balls) {
    const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.1, b.x, b.y, b.r);
    g.addColorStop(0, "#fff");
    g.addColorStop(1, `hsl(${b.hue}, 80%, 55%)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
  shell.fx.draw();
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  shell.text("❤".repeat(MAX_DROPS - drops) + "♡".repeat(drops), 16, 60 * S, { align: "left" });
  shell.text(`球 ×${balls.length}`, 16, 90 * S, { align: "left" });
}

shell.loop((dt) => {
  shell.detect();
  if (DEBUG && mouse) addMouseShadow();
  else readMask();

  if (state === "playing") update(dt);
  else shell.updateHoldStart(topCoverage > 0.12, dt, "保持舉手");
  shell.fx.update(dt);

  shell.drawVideo();
  drawShadow();
  if (state === "playing") draw();
});

shell.init();
