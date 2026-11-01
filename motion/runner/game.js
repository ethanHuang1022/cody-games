import { createShell, sound, lerp, rand, pick, DEBUG } from "../shared/shell.js";
import { J, bodyGeom, drawSkeleton } from "../shared/pose.js";

const shell = createShell({
  title: "原地跑酷",
  model: "pose",
  help: [
    "↔️ 身體<b>往左／右移</b>：換跑道（往旁邊跨一步也可以）",
    "⬆️ <b>跳起來</b>：跳過低欄　⬇️ <b>蹲下</b>：鑽過高桿",
    "🧱 整面牆只能換跑道閃開，🪙 金幣記得吃",
    "📏 離鏡頭約 2～3 公尺，開始前站在中間 2 秒量身形",
  ],
  hint: "🙌 雙手舉高過頭撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高過頭 1 秒，或按「開始」",
});
const { ctx } = shell;

const MAX_LIVES = 3;
const FAR = 40; // 物件出現的距離

let state = "menu"; // menu | calib | playing
let calibT = 0;
let samples = [];
let base = null; // { x, hipY, T }
let geom = null;
let lane = 1;
let laneX = 1; // 平滑後的跑道位置（畫面用）
let jumpT = 0; // >0 表示在空中
let ducking = false;
let lives = 0;
let invuln = 0;
let dist = 0;
let coins = 0;
let speed = 0;
let things = [];
let spawnZ = 0;
let flash = 0;
const keys = new Set();

window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));

const sfx = {
  jump: () => sound.tone(300, { to: 700, type: "triangle", dur: 0.18, vol: 0.18 }),
  duck: () => sound.noise({ dur: 0.15, vol: 0.15, freq: 1200, to: 400 }),
  lane: () => sound.tone(500, { type: "sine", dur: 0.05, vol: 0.1 }),
  coin: () => sound.arpeggio([988, 1319], 0.05, { type: "square", dur: 0.08, vol: 0.08 }),
  crash() {
    sound.noise({ dur: 0.5, vol: 0.5, freq: 800, to: 80 });
    sound.tone(160, { to: 50, type: "square", dur: 0.3, vol: 0.2 });
  },
};

function start() {
  state = "calib";
  calibT = 0;
  samples = [];
  shell.hideMenu();
}
shell.onStart(start);

function beginRun() {
  if (samples.length) {
    const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
    base = { x: avg("x"), hipY: avg("hipY"), T: avg("T") };
  } else base = { x: shell.W / 2, hipY: shell.H * 0.6, T: shell.H * 0.2 };
  state = "playing";
  lane = 1;
  laneX = 1;
  jumpT = 0;
  ducking = false;
  lives = MAX_LIVES;
  invuln = 0;
  dist = 0;
  coins = 0;
  speed = 14;
  things = [];
  spawnZ = 15;
  shell.fx.clear();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const score = Math.floor(dist) + coins * 10;
  const best = shell.saveBest(score);
  shell.showMenu({
    title: "跑不動了！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>跑了 <b>${Math.floor(dist)}</b> 公尺　·　金幣 <b>${coins}</b> 枚</p>`,
  });
  sound.sfx.gameOver();
}

// 讀身體動作 → 跑道、跳、蹲
function readBody() {
  if (DEBUG && !geom) {
    let want = 1;
    if (keys.has("ArrowLeft")) want = 0;
    if (keys.has("ArrowRight")) want = 2;
    return { lane: want, jump: keys.has("ArrowUp"), duck: keys.has("ArrowDown") };
  }
  if (!geom?.full) return null;
  const dx = (geom.sh.x - base.x) / base.T;
  const want = dx < -0.45 ? 0 : dx > 0.45 ? 2 : 1;
  const rise = (base.hipY - geom.hip.y) / base.T;
  return { lane: want, jump: rise > 0.15, duck: rise < -0.35 };
}

function spawnRow() {
  const r = Math.random();
  if (r < 0.25) {
    // 一排金幣
    const l = Math.floor(Math.random() * 3);
    for (let i = 0; i < 5; i++) things.push({ type: "coin", lane: l, z: FAR + i * 1.5 });
    return;
  }
  const type = pick(["block", "low", "bar"]);
  if (type === "block") {
    // 擋住一或兩個跑道
    const free = Math.floor(Math.random() * 3);
    for (let l = 0; l < 3; l++) if (l !== free && (Math.random() < 0.6 || l === (free + 1) % 3)) things.push({ type, lane: l, z: FAR });
  } else {
    // 低欄、高桿橫跨三個跑道
    for (let l = 0; l < 3; l++) things.push({ type, lane: l, z: FAR });
  }
}

function update(dt) {
  const ctl = readBody();
  if (!ctl) return; // 看不到全身就暫停
  if (ctl.lane !== lane) {
    lane = ctl.lane;
    sfx.lane();
  }
  laneX = lerp(laneX, lane, Math.min(1, dt * 12));
  if (ctl.jump && jumpT <= 0) {
    jumpT = 0.75;
    sfx.jump();
  }
  if (ctl.duck && !ducking) sfx.duck();
  ducking = ctl.duck && jumpT <= 0;
  jumpT = Math.max(0, jumpT - dt);
  invuln = Math.max(0, invuln - dt);

  speed = Math.min(30, speed + dt * 0.25);
  dist += speed * dt;
  spawnZ -= speed * dt;
  if (spawnZ <= 0) {
    spawnZ = rand(9, 15) - speed * 0.05;
    spawnRow();
  }

  for (const o of things) {
    o.z -= speed * dt;
    if (o.done || o.z > 0.8 || o.z < -0.5 || o.lane !== lane) continue;
    if (o.type === "coin") {
      o.done = true;
      coins += 1;
      sfx.coin();
      continue;
    }
    const safe = (o.type === "low" && jumpT > 0.1) || (o.type === "bar" && ducking);
    if (!safe && invuln <= 0) {
      o.done = true;
      lives -= 1;
      invuln = 1.2;
      flash = 0.3;
      sfx.crash();
      if (lives <= 0) {
        end();
        return;
      }
    }
  }
  things = things.filter((o) => o.z > -2 && !(o.done && o.type === "coin"));
}

// ---------- 偽 3D 繪製 ----------

const horizon = () => shell.H * 0.38;
function project(lanePos, z) {
  const { W, H } = shell;
  const p = 1 / (1 + Math.max(z, -0.9) * 0.18);
  return { x: W / 2 + (lanePos - 1) * W * 0.26 * p, y: horizon() + (H * 0.97 - horizon()) * p, s: p };
}

function drawWorld() {
  const { W, H } = shell;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon());
  sky.addColorStop(0, "#1b2a5c");
  sky.addColorStop(1, "#5b7bd6");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon());
  ctx.fillStyle = "#2e7d4f";
  ctx.fillRect(0, horizon(), W, H - horizon());

  // 跑道
  const far = project(-0.5, FAR);
  const far2 = project(2.5, FAR);
  const near = project(-0.5, -0.5);
  const near2 = project(2.5, -0.5);
  ctx.fillStyle = "#6b5b4b";
  ctx.beginPath();
  ctx.moveTo(far.x, far.y);
  ctx.lineTo(far2.x, far2.y);
  ctx.lineTo(near2.x, near2.y);
  ctx.lineTo(near.x, near.y);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  for (const l of [0.5, 1.5]) {
    const a = project(l, FAR);
    const b = project(l, -0.5);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // 地面橫紋，營造速度感
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  for (let z = (-dist % 3) + 3; z < FAR; z += 3) {
    const a = project(-0.5, z);
    const b = project(2.5, z);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 由遠到近畫物件
  const sorted = [...things].sort((a, b) => b.z - a.z);
  for (const o of sorted) {
    if (o.done && o.type !== "coin") continue;
    const p = project(o.lane, o.z);
    const w = W * 0.22 * p.s;
    if (o.type === "coin") {
      ctx.fillStyle = "#ffd447";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - w * 0.4, w * 0.18 * Math.abs(Math.cos(dist * 0.5)) + 1, w * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.type === "block") {
      ctx.fillStyle = "#c0504d";
      ctx.fillRect(p.x - w / 2, p.y - w * 1.3, w, w * 1.3);
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.strokeRect(p.x - w / 2, p.y - w * 1.3, w, w * 1.3);
    } else if (o.type === "low") {
      ctx.fillStyle = "#ffb52e";
      ctx.fillRect(p.x - w / 2, p.y - w * 0.35, w, w * 0.12);
      ctx.fillRect(p.x - w / 2, p.y - w * 0.35, w * 0.06, w * 0.35);
      ctx.fillRect(p.x + w / 2 - w * 0.06, p.y - w * 0.35, w * 0.06, w * 0.35);
    } else if (o.type === "bar") {
      ctx.fillStyle = "#59c8ff";
      ctx.fillRect(p.x - w / 2, p.y - w * 1.1, w, w * 0.14);
      ctx.fillRect(p.x - w / 2, p.y - w * 1.1, w * 0.06, w * 1.1);
      ctx.fillRect(p.x + w / 2 - w * 0.06, p.y - w * 1.1, w * 0.06, w * 1.1);
    }
  }

  // 跑者
  const p = project(laneX, 0);
  const h = W * 0.11 * (ducking ? 0.55 : 1);
  const lift = jumpT > 0 ? Math.sin((jumpT / 0.75) * Math.PI) * W * 0.09 : 0;
  if (invuln > 0 && Math.floor(invuln * 10) % 2 === 0) return;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, h * 0.35, h * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff7b54";
  ctx.fillRect(p.x - h * 0.22, p.y - lift - h, h * 0.44, h * 0.75);
  ctx.fillStyle = "#ffd9b3";
  ctx.beginPath();
  ctx.arc(p.x, p.y - lift - h - h * 0.12, h * 0.17, 0, Math.PI * 2);
  ctx.fill();
  const leg = Math.sin(dist * 1.5) * h * 0.12;
  ctx.fillStyle = "#334";
  ctx.fillRect(p.x - h * 0.2, p.y - lift - h * 0.25, h * 0.15, h * 0.25 + leg);
  ctx.fillRect(p.x + h * 0.05, p.y - lift - h * 0.25, h * 0.15, h * 0.25 - leg);
}

// 右下角小畫面：看到自己和骨架
function drawPip() {
  const { W, H, S } = shell;
  const v = shell.video;
  const w = 220 * S;
  const h = w * 0.5625;
  const x = W - w - 16;
  const y = H - h - 16;
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, h);
  if (v.readyState >= 2) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, w, h);
    ctx.restore();
  }
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

function drawHud() {
  const { S } = shell;
  shell.text(`${Math.floor(dist)} 公尺`, 16, 30 * S, { align: "left", bold: true });
  shell.text(`🪙 ${coins}`, 16, 60 * S, { align: "left" });
  shell.text("❤".repeat(Math.max(0, lives)) + "♡".repeat(MAX_LIVES - Math.max(0, lives)), 16, 90 * S, { align: "left" });
}

shell.loop((dt) => {
  const res = shell.detect();
  const lm = res?.landmarks?.[0];
  geom = lm ? bodyGeom(shell, lm) : null;
  const { W, H } = shell;

  if (state === "calib") {
    if (DEBUG || geom?.full) {
      calibT += dt;
      if (geom) samples.push({ x: geom.sh.x, hipY: geom.hip.y, T: geom.T });
      if (calibT >= 2) beginRun();
    } else {
      calibT = 0;
      samples = [];
    }
  } else if (state === "playing") update(dt);
  else {
    const up = geom && geom.p[J.lw].y < geom.p[J.nose].y && geom.p[J.rw].y < geom.p[J.nose].y;
    shell.updateHoldStart(up, dt, "保持舉手");
  }
  flash = Math.max(0, flash - dt);

  if (state === "playing") {
    drawWorld();
    drawPip();
    drawHud();
    if (!DEBUG && !geom?.full) shell.banner("暫停中", "看不到全身，請退後一點");
  } else {
    shell.drawVideo();
    if (geom) drawSkeleton(shell, geom, geom.full ? "#5be37d" : "#ff5b5b");
    if (state === "calib") {
      if (DEBUG || geom?.full) shell.banner("站在中間別動", "正在量測你的位置…", calibT / 2);
      else shell.banner("請退後一點", "讓頭到腳都出現在畫面裡");
    }
  }
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,60,60,${flash})`;
    ctx.fillRect(0, 0, W, H);
  }
});

shell.init();
