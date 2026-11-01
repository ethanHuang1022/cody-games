import { createShell, sound, clamp, rand, dist, DEBUG, HAND, isOpenPalm } from "../shared/shell.js";

const shell = createShell({
  title: "水晶劍士",
  model: "hand",
  dim: 0.35,
  help: [
    "☝️ 食指指尖就是你的劍，<b>快速揮過</b>水晶就能切開",
    "🎯 只切畫面上方指定<b>顏色</b>的水晶，切錯顏色會扣一顆心",
    "🎨 目標顏色每 8 秒換一次，連續切對有連擊加分",
    "⏱️ 限時 60 秒，兩隻手都可以用",
  ],
  hint: "✋ 張開手掌撐 1 秒即可開始",
  readyText: "準備好了！張開手掌撐 1 秒，或按「開始」",
});
const { ctx } = shell;

const COLORS = [
  { name: "紅色", c: "#ff5b5b", dot: "🔴" },
  { name: "藍色", c: "#59c8ff", dot: "🔵" },
  { name: "綠色", c: "#5be37d", dot: "🟢" },
];
const GAME_TIME = 60;
const TARGET_TIME = 8;
const MAX_LIVES = 3;

let state = "menu";
let crystals = [];
let halves = [];
let blades = []; // 每隻手一把劍：{ x, y, trail: [{x,y,age}] }
let target = 0;
let targetT = 0;
let spawnT = 0;
let timeLeft = 0;
let score = 0;
let combo = 0;
let maxCombo = 0;
let lives = 0;
let sliced = 0;
let shake = 0;

// 除錯模式：用滑鼠當劍
let mouse = null;
if (DEBUG) {
  window.addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }));
}

const sfx = {
  slice() {
    sound.noise({ dur: 0.12, vol: 0.3, freq: 5000, to: 1500, type: "highpass" });
    sound.tone(1200 + combo * 40, { type: "triangle", dur: 0.12, vol: 0.18 });
  },
  wrong() {
    sound.tone(180, { to: 90, type: "square", dur: 0.3, vol: 0.2 });
  },
  change() {
    sound.arpeggio([784, 988], 0.08, { type: "triangle", dur: 0.15, vol: 0.18 });
  },
};

function start() {
  state = "playing";
  crystals = [];
  halves = [];
  blades = [];
  score = 0;
  combo = 0;
  maxCombo = 0;
  sliced = 0;
  lives = MAX_LIVES;
  timeLeft = GAME_TIME;
  target = Math.floor(Math.random() * COLORS.length);
  targetT = TARGET_TIME;
  spawnT = 0.5;
  shell.fx.clear();
  shell.hideMenu();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  shell.showMenu({
    title: lives <= 0 ? "劍斷了！" : "時間到！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>切開 <b>${sliced}</b> 顆水晶　·　最高連擊 <b>${maxCombo}</b></p>`,
  });
  sound.sfx.gameOver();
}

shell.onStart(start);

function spawn() {
  const { W, H, S } = shell;
  const g = H * 1.2;
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const x = rand(0.15, 0.85) * W;
    const h = rand(0.5, 0.85) * H;
    crystals.push({
      x,
      y: H + 40 * S,
      vx: (W / 2 - x) * rand(0.2, 0.5),
      vy: -Math.sqrt(2 * g * h),
      r: rand(30, 42) * S,
      color: Math.random() < 0.45 ? target : Math.floor(Math.random() * COLORS.length),
      rot: Math.random() * Math.PI,
      vr: rand(-3, 3),
    });
  }
}

// 線段 (a→b) 與圓心距離
function segDist(a, b, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((c.x - a.x) * dx + (c.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(a.x + dx * t - c.x, a.y + dy * t - c.y);
}

function updateBlades(dt, hands) {
  const tips = DEBUG && mouse ? [mouse] : hands.map((h) => shell.toScreen(h[HAND.indexTip]));
  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    let b = blades[i];
    if (!b) b = blades[i] = { x: tip.x, y: tip.y, trail: [], speed: 0 };
    const prev = { x: b.x, y: b.y };
    const moved = dist(prev, tip);
    b.speed = smoothSpeed(b.speed, moved / Math.max(dt, 1 / 60));
    b.x = tip.x;
    b.y = tip.y;
    b.trail.push({ x: tip.x, y: tip.y, age: 0 });
    if (state === "playing" && b.speed > 700 * shell.S && moved > 0) trySlice(prev, tip);
  }
  blades.length = tips.length;
  for (const b of blades) {
    for (const p of b.trail) p.age += dt;
    b.trail = b.trail.filter((p) => p.age < 0.18);
  }
}

const smoothSpeed = (a, b) => a + (b - a) * 0.6;

function trySlice(a, b) {
  for (const c of crystals) {
    if (c.dead || segDist(a, b, c) > c.r) continue;
    c.dead = true;
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
    for (const side of [-1, 1]) {
      halves.push({
        ...c,
        vx: c.vx + Math.cos(ang) * side * 160 * shell.S,
        vy: c.vy + Math.sin(ang) * side * 160 * shell.S,
        side,
        cut: ang,
        life: 1,
      });
    }
    shell.fx.burst(c.x, c.y, COLORS[c.color].c, 18);
    if (c.color === target) {
      combo += 1;
      maxCombo = Math.max(maxCombo, combo);
      sliced += 1;
      const gain = 10 * (1 + Math.floor(combo / 5));
      score += gain;
      shell.fx.text(`+${gain}`, c.x, c.y - c.r, "#fff");
      sfx.slice();
    } else {
      combo = 0;
      lives -= 1;
      shake = 0.35;
      shell.fx.text("顏色錯了！", c.x, c.y - c.r, "#ff8080");
      sfx.wrong();
    }
  }
}

function update(dt) {
  const { H, S } = shell;
  timeLeft -= dt;
  targetT -= dt;
  if (targetT <= 0) {
    targetT = TARGET_TIME;
    target = (target + 1 + Math.floor(Math.random() * (COLORS.length - 1))) % COLORS.length;
    sfx.change();
  }
  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = rand(0.55, 1.1) * clamp(timeLeft / GAME_TIME + 0.4, 0.6, 1);
    spawn();
  }
  const g = H * 1.2;
  for (const c of [...crystals, ...halves]) {
    c.vy += g * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.rot += c.vr * dt;
  }
  for (const c of crystals) {
    // 目標顏色的水晶掉出畫面就斷連擊
    if (!c.dead && c.vy > 0 && c.y > H + 60 * S) {
      c.dead = true;
      if (c.color === target) combo = 0;
    }
  }
  for (const h of halves) h.life -= dt;
  crystals = crystals.filter((c) => !c.dead);
  halves = halves.filter((h) => h.life > 0);
  if (lives <= 0 || timeLeft <= 0) end();
}

function crystalPath(r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const rr = i % 3 === 0 ? r * 1.25 : r;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
}

function drawCrystal(c, clipSide = 0) {
  ctx.save();
  ctx.translate(c.x, c.y);
  if (clipSide) {
    ctx.globalAlpha = clamp(c.life, 0, 1);
    ctx.rotate(c.cut);
    ctx.beginPath();
    ctx.rect(-c.r * 2, clipSide < 0 ? -c.r * 2 : 0, c.r * 4, c.r * 2);
    ctx.clip();
    ctx.rotate(-c.cut);
  }
  ctx.rotate(c.rot);
  const col = COLORS[c.color].c;
  ctx.fillStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 18 * shell.S;
  crystalPath(c.r);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  crystalPath(c.r * 0.5);
  ctx.fill();
  ctx.restore();
}

function drawBlades() {
  const { S } = shell;
  for (const b of blades) {
    const t = b.trail;
    for (let i = 1; i < t.length; i++) {
      const k = 1 - t[i].age / 0.18;
      ctx.strokeStyle = `rgba(200, 240, 255, ${k})`;
      ctx.lineWidth = 10 * S * k;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(t[i - 1].x, t[i - 1].y);
      ctx.lineTo(t[i].x, t[i].y);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(b.x, b.y, 8 * S, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHud() {
  const { W, S } = shell;
  const t = COLORS[target];
  shell.text(`目標：${t.dot} ${t.name}水晶`, W / 2, 44 * S, { size: 34, bold: true, color: t.c });
  shell.bar(W / 2 - 120 * S, 70 * S, 240 * S, 8 * S, targetT / TARGET_TIME, t.c);
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  shell.text("❤".repeat(Math.max(0, lives)) + "♡".repeat(MAX_LIVES - Math.max(0, lives)), 16, 60 * S, { align: "left" });
  shell.text(`⏱️ ${Math.ceil(timeLeft)}`, 16, 90 * S, { align: "left" });
  if (combo >= 3) shell.text(`${combo} 連擊！`, 16, 122 * S, { align: "left", bold: true, color: "#ffd447", size: 26 });
}

shell.loop((dt) => {
  const res = shell.detect();
  const hands = res?.landmarks ?? [];
  if (shell.fresh || DEBUG) updateBlades(dt, hands);
  else for (const b of blades) for (const p of b.trail) p.age += dt;

  if (state === "playing") update(dt);
  else shell.updateHoldStart(hands.some(isOpenPalm), dt, "保持張開手掌");
  shell.fx.update(dt);
  shake = Math.max(0, shake - dt);

  ctx.save();
  if (shake > 0) ctx.translate(rand(-12, 12) * shake, rand(-12, 12) * shake);
  shell.drawVideo();
  if (state === "playing") {
    for (const c of crystals) drawCrystal(c);
    for (const h of halves) drawCrystal(h, h.side);
    shell.fx.draw();
    drawHud();
  }
  drawBlades();
  ctx.restore();
});

shell.init();
