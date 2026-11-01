import { createShell, sound, clamp, rand, smooth, dist, DEBUG } from "../shared/shell.js";

const shell = createShell({
  title: "眨眼射手",
  model: "face",
  dim: 0.7,
  help: [
    "🙂 <b>轉頭</b>移動準星（開始前會先記住你正視前方的位置）",
    "😑 <b>雙眼眨一下</b>就射擊（自然眨眼也會射，算是福利！）",
    "🤨 <b>挑眉</b>放出炸彈清空全場，打中 10 個目標可充滿一次",
    "🎯 🛸 +10、🎈 +20、⭐ +50（會移動），限時 60 秒",
  ],
  hint: "😮 張嘴撐 1 秒即可開始",
  readyText: "準備好了！張嘴撐 1 秒，或按「開始」",
});
const { ctx } = shell;

const GAME_TIME = 60;
const BLINK_ON = 0.5;
const BLINK_OFF = 0.3;
const TYPES = [
  { icon: "🛸", pts: 10, r: 38, life: 3, weight: 6 },
  { icon: "🎈", pts: 20, r: 30, life: 2.4, weight: 3 },
  { icon: "⭐", pts: 50, r: 24, life: 2, weight: 1, moving: true },
];

let state = "menu"; // menu | calib | playing
let calibT = 0;
let calibSamples = [];
let center = null; // 正視時的鼻尖位置與眉毛基準
let face = null; // { nose, blink, brow, jaw }
let aim = { x: 0, y: 0 };
let blinkClosed = false;
let browUp = false;
let cooldown = 0;
let targets = [];
let spawnT = 0;
let timeLeft = 0;
let score = 0;
let shots = 0;
let hits = 0;
let charge = 0;
let flashes = [];
let bombFlash = 0;

// 除錯模式：滑鼠瞄準、點擊射擊、B 鍵炸彈
let debugShoot = false;
let debugBomb = false;
if (DEBUG) {
  window.addEventListener("pointermove", (e) => (aim = { x: e.clientX, y: e.clientY }));
  window.addEventListener("pointerdown", () => (debugShoot = true));
  window.addEventListener("keydown", (e) => e.code === "KeyB" && (debugBomb = true));
}

const sfx = {
  shot: () => sound.noise({ dur: 0.1, vol: 0.3, freq: 3000, to: 500, type: "bandpass" }),
  hit: () => sound.arpeggio([880, 1320], 0.04, { type: "square", dur: 0.08, vol: 0.1 }),
  bomb() {
    sound.noise({ dur: 0.9, vol: 0.6, freq: 1500, to: 50 });
    sound.tone(80, { to: 30, type: "sine", dur: 0.8, vol: 0.4 });
  },
  ready: () => sound.arpeggio([523, 784, 1047], 0.07, { type: "triangle", dur: 0.12, vol: 0.15 }),
};

function start() {
  state = "calib";
  calibT = 0;
  calibSamples = [];
  shell.hideMenu();
}
shell.onStart(start);

function beginPlay() {
  if (calibSamples.length) {
    const avg = (f) => calibSamples.reduce((a, s) => a + f(s), 0) / calibSamples.length;
    center = { x: avg((s) => s.nose.x), y: avg((s) => s.nose.y), brow: avg((s) => s.brow) };
  } else center = { x: 0.5, y: 0.5, brow: 0.1 };
  state = "playing";
  targets = [];
  spawnT = 0.5;
  timeLeft = GAME_TIME;
  score = 0;
  shots = 0;
  hits = 0;
  charge = 0;
  aim = { x: shell.W / 2, y: shell.H / 2 };
  shell.fx.clear();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  const acc = shots ? Math.round((hits / shots) * 100) : 0;
  shell.showMenu({
    title: "時間到！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>射擊 <b>${shots}</b> 次　·　命中 <b>${hits}</b>　·　命中率 <b>${acc}%</b></p>`,
  });
  sound.sfx.gameOver();
}

function readFace() {
  const res = shell.result;
  const lm = res?.faceLandmarks?.[0];
  if (!lm) {
    face = null;
    return;
  }
  const bs = {};
  for (const c of res.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
  face = {
    nose: lm[1],
    blink: Math.min(bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0),
    brow: bs.browInnerUp ?? 0,
    jaw: bs.jawOpen ?? 0,
  };
}

function spawnTarget() {
  const { W, H, S } = shell;
  const total = TYPES.reduce((a, t) => a + t.weight, 0);
  let r = Math.random() * total;
  const type = TYPES.find((t) => (r -= t.weight) < 0) ?? TYPES[0];
  targets.push({
    ...type,
    x: rand(0.12, 0.88) * W,
    y: rand(0.2, 0.85) * H,
    r: type.r * S,
    age: 0,
    vx: type.moving ? rand(-1, 1) * 220 * S : 0,
    vy: type.moving ? rand(-1, 1) * 160 * S : 0,
  });
}

function shoot() {
  shots += 1;
  sfx.shot();
  flashes.push({ x: aim.x, y: aim.y, t: 0.15 });
  for (const t of targets) {
    if (t.dead || dist(t, aim) > t.r * 1.3) continue;
    t.dead = true;
    hits += 1;
    score += t.pts;
    charge = Math.min(10, charge + 1);
    if (charge === 10) sfx.ready();
    shell.fx.burst(t.x, t.y, "#ffd447", 18);
    shell.fx.text(`+${t.pts}`, t.x, t.y - t.r, "#fff");
    sfx.hit();
    break;
  }
}

function bomb() {
  charge = 0;
  bombFlash = 0.5;
  sfx.bomb();
  for (const t of targets) {
    if (t.dead) continue;
    t.dead = true;
    hits += 1;
    score += t.pts;
    shell.fx.burst(t.x, t.y, "#ff7b54", 24, 500);
  }
}

function update(dt) {
  const { W, H } = shell;
  timeLeft -= dt;
  cooldown = Math.max(0, cooldown - dt);

  if (!DEBUG && face) {
    // 鼻尖相對正視位置的偏移放大成整個畫面（x 要鏡像）
    const tx = W / 2 - ((face.nose.x - center.x) / 0.09) * (W / 2);
    const ty = H / 2 + ((face.nose.y - center.y) / 0.07) * (H / 2);
    aim.x = smooth(aim.x, clamp(tx, 0, W), 0.4);
    aim.y = smooth(aim.y, clamp(ty, 0, H), 0.4);

    // 眨眼：閉上再張開才算一次，加遲滯避免連發
    if (!blinkClosed && face.blink > BLINK_ON) {
      blinkClosed = true;
      if (cooldown <= 0) {
        shoot();
        cooldown = 0.2;
      }
    } else if (blinkClosed && face.blink < BLINK_OFF) blinkClosed = false;

    const browHigh = face.brow - center.brow > 0.35;
    if (browHigh && !browUp && charge >= 10) bomb();
    browUp = browHigh;
  }
  if (debugShoot) {
    debugShoot = false;
    shoot();
  }
  if (debugBomb) {
    debugBomb = false;
    if (charge >= 10) bomb();
  }

  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = rand(0.5, 1.1);
    if (targets.length < 7) spawnTarget();
  }
  for (const t of targets) {
    t.age += dt;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    if (t.x < t.r || t.x > W - t.r) t.vx *= -1;
    if (t.y < t.r || t.y > H - t.r) t.vy *= -1;
  }
  targets = targets.filter((t) => !t.dead && t.age < t.life);
  for (const f of flashes) f.t -= dt;
  flashes = flashes.filter((f) => f.t > 0);
  bombFlash = Math.max(0, bombFlash - dt);
  if (timeLeft <= 0) end();
}

function draw() {
  const { W, H, S } = shell;
  for (const t of targets) {
    const k = 1 - t.age / t.life;
    ctx.globalAlpha = clamp(k * 3, 0, 1);
    shell.text(t.icon, t.x, t.y, { size: (t.r / S) * 1.6 });
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 3 * S;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r * 1.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const f of flashes) {
    ctx.fillStyle = `rgba(255,255,200,${f.t / 0.15})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 30 * S, 0, Math.PI * 2);
    ctx.fill();
  }
  // 準星
  ctx.strokeStyle = blinkClosed ? "#ff5b5b" : "#fff";
  ctx.lineWidth = 3 * S;
  ctx.beginPath();
  ctx.arc(aim.x, aim.y, 26 * S, 0, Math.PI * 2);
  ctx.moveTo(aim.x - 40 * S, aim.y);
  ctx.lineTo(aim.x - 12 * S, aim.y);
  ctx.moveTo(aim.x + 12 * S, aim.y);
  ctx.lineTo(aim.x + 40 * S, aim.y);
  ctx.moveTo(aim.x, aim.y - 40 * S);
  ctx.lineTo(aim.x, aim.y - 12 * S);
  ctx.moveTo(aim.x, aim.y + 12 * S);
  ctx.lineTo(aim.x, aim.y + 40 * S);
  ctx.stroke();

  shell.fx.draw();
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  shell.text(`⏱️ ${Math.ceil(timeLeft)}`, 16, 60 * S, { align: "left" });
  shell.text(charge >= 10 ? "💣 炸彈就緒！挑眉！" : `💣 ${charge}/10`, 16, 90 * S, { align: "left", color: charge >= 10 ? "#ffd447" : "#fff" });
  if (!DEBUG && !face) shell.text("找不到臉，請面向鏡頭", W / 2, H - 40 * S, { color: "#ffb3b3" });
  if (bombFlash > 0) {
    ctx.fillStyle = `rgba(255,200,120,${bombFlash})`;
    ctx.fillRect(0, 0, W, H);
  }
}

shell.loop((dt) => {
  shell.detect();
  readFace();

  if (state === "calib") {
    if (face || DEBUG) {
      calibT += dt;
      if (face) calibSamples.push({ nose: face.nose, brow: face.brow });
      if (calibT >= 1.5) beginPlay();
    }
  } else if (state === "playing") update(dt);
  else shell.updateHoldStart((face?.jaw ?? 0) > 0.5, dt, "保持張嘴");
  shell.fx.update(dt);

  shell.drawVideo();
  if (state === "calib") shell.banner("看著畫面正中央", "放鬆表情，正在記住你的位置…", calibT / 1.5);
  if (state === "playing") draw();
});

shell.init();
