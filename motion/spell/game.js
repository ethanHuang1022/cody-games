import { createShell, sound, clamp, rand, pick, DEBUG } from "../shared/shell.js";

const shell = createShell({
  title: "手勢咒語",
  model: "gesture",
  dim: 0.55,
  help: [
    "👻 幽靈會帶著<b>手勢咒語</b>從右邊飄過來",
    "🖐️ 對鏡頭<b>依序</b>比出咒語上的手勢就能施法消滅它",
    "🔁 同一個手勢連續出現時，要先放下手或換個手勢再比一次",
    "💔 幽靈碰到法師就扣一顆心，共 3 顆",
  ],
  hint: "✋ 張開手掌撐 1 秒即可開始",
  readyText: "準備好了！張開手掌撐 1 秒，或按「開始」",
});
const { ctx } = shell;

// MediaPipe 手勢分類名稱 → 圖示
const GESTURES = {
  Closed_Fist: "✊",
  Open_Palm: "✋",
  Pointing_Up: "☝️",
  Thumb_Up: "👍",
  Thumb_Down: "👎",
  Victory: "✌️",
  ILoveYou: "🤟",
};
const NAMES = Object.keys(GESTURES);
const HOLD = 0.25; // 手勢要穩定多久才算數
const MAX_LIVES = 3;

let state = "menu";
let ghosts = [];
let bolts = [];
let lives = 0;
let score = 0;
let killed = 0;
let level = 0;
let spawnT = 0;
let elapsed = 0;
let gesture = null; // 目前偵測到的手勢
let gestureT = 0; // 已維持多久
let needRelease = false; // 剛施完一個符號，要先放開
let debugGesture = null;
let debugT = 0;

// 除錯模式：數字鍵 1~7 比出對應手勢
if (DEBUG) {
  window.addEventListener("keydown", (e) => {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < NAMES.length) {
      debugGesture = NAMES[i];
      debugT = 0.5;
    }
  });
}

const sfx = {
  rune: () => sound.tone(700, { to: 1100, type: "sine", dur: 0.12, vol: 0.18 }),
  cast() {
    sound.noise({ dur: 0.3, vol: 0.3, freq: 800, to: 4000, type: "bandpass" });
    sound.tone(400, { to: 1600, type: "sawtooth", dur: 0.25, vol: 0.1 });
  },
  poof() {
    sound.noise({ dur: 0.4, vol: 0.35, freq: 2000, to: 200 });
    sound.arpeggio([784, 1047], 0.06, { type: "triangle", dur: 0.15, vol: 0.18 });
  },
  hurt() {
    sound.tone(220, { to: 70, type: "sawtooth", dur: 0.4, vol: 0.2 });
  },
};

function start() {
  state = "playing";
  ghosts = [];
  bolts = [];
  lives = MAX_LIVES;
  score = 0;
  killed = 0;
  level = 0;
  spawnT = 0.5;
  elapsed = 0;
  needRelease = false;
  shell.fx.clear();
  shell.hideMenu();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  shell.showMenu({
    title: "法師倒下了！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>消滅 <b>${killed}</b> 隻幽靈　·　撐了 ${Math.floor(elapsed)} 秒</p>`,
  });
  sound.sfx.gameOver();
}
shell.onStart(start);

function spawnGhost() {
  level += 1;
  const len = clamp(1 + Math.floor(level / 4) + (Math.random() < 0.3 ? 1 : 0), 1, 4);
  const runes = [];
  for (let i = 0; i < len; i++) runes.push(pick(NAMES));
  const { W, H } = shell;
  ghosts.push({
    x: W + 60,
    y: rand(0.3, 0.75) * H,
    runes,
    done: 0,
    speed: clamp(0.045 + level * 0.002, 0.045, 0.09) * W, // 每秒移動的像素
    t: Math.random() * 10,
    status: "walk", // walk | targeted（法術飛行中）| dying
    fade: 0,
  });
}

// 讀取目前手勢（分數夠高才算）
function readGesture(dt) {
  let g = null;
  if (DEBUG && debugT > 0) {
    debugT -= dt;
    g = debugGesture;
  } else {
    const top = shell.result?.gestures?.[0]?.[0];
    if (top && top.score > 0.6 && GESTURES[top.categoryName]) g = top.categoryName;
  }
  if (g === gesture) gestureT += dt;
  else {
    gesture = g;
    gestureT = 0;
    needRelease = false; // 換了手勢就解除鎖定
  }
}

const wizard = () => ({ x: shell.W * 0.12, y: shell.H * 0.62 });

function update(dt) {
  elapsed += dt;
  spawnT -= dt;
  if (spawnT <= 0) {
    spawnT = clamp(5 - level * 0.12, 2.2, 5);
    spawnGhost();
  }

  // 對最前面（最靠近法師）的幽靈施法
  const front = ghosts.filter((g) => g.status === "walk").sort((a, b) => a.x - b.x)[0];
  if (front && gesture && !needRelease && gestureT >= HOLD && front.runes[front.done] === gesture) {
    front.done += 1;
    needRelease = true;
    sfx.rune();
    if (front.done >= front.runes.length) {
      const w = wizard();
      bolts.push({ x: w.x + 40, y: w.y - 60, target: front, t: 0 });
      front.status = "targeted";
      sfx.cast();
    }
  }

  const w = wizard();
  for (const g of ghosts) {
    g.t += dt;
    if (g.status === "dying") g.fade -= dt;
    else if (g.status === "walk") {
      g.x -= g.speed * dt;
      if (g.x < w.x + 50) {
        g.status = "dying";
        g.fade = 0.3;
        lives -= 1;
        shell.fx.burst(w.x, w.y - 40, "#ff5b5b", 24);
        sfx.hurt();
      }
    }
  }
  for (const b of bolts) {
    b.t += dt * 3;
    const tg = b.target;
    b.x += (tg.x - b.x) * Math.min(1, b.t);
    b.y += (tg.y - b.y) * Math.min(1, b.t);
    if (b.t >= 1 && !b.done) {
      b.done = true;
      tg.status = "dying";
      tg.fade = 0.5;
      killed += 1;
      const gain = 50 * tg.runes.length;
      score += gain;
      shell.fx.burst(tg.x, tg.y, "#c9a8ff", 30);
      shell.fx.text(`+${gain}`, tg.x, tg.y - 50, "#fff");
      sfx.poof();
    }
  }
  bolts = bolts.filter((b) => !b.done);
  ghosts = ghosts.filter((g) => g.status !== "dying" || g.fade > 0);
  if (lives <= 0) end();
}

function drawWizard() {
  const { S } = shell;
  const { x, y } = wizard();
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#6a4cff";
  ctx.beginPath();
  ctx.moveTo(-40 * S, 60 * S);
  ctx.lineTo(40 * S, 60 * S);
  ctx.lineTo(0, -40 * S);
  ctx.fill();
  ctx.fillStyle = "#ffd9b3";
  ctx.beginPath();
  ctx.arc(0, -30 * S, 18 * S, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4b33c2";
  ctx.beginPath();
  ctx.moveTo(-28 * S, -40 * S);
  ctx.lineTo(28 * S, -40 * S);
  ctx.lineTo(5 * S, -110 * S);
  ctx.fill();
  ctx.strokeStyle = "#a07040";
  ctx.lineWidth = 5 * S;
  ctx.beginPath();
  ctx.moveTo(35 * S, 50 * S);
  ctx.lineTo(45 * S, -60 * S);
  ctx.stroke();
  ctx.fillStyle = gesture ? "#c9a8ff" : "#888";
  ctx.shadowColor = "#c9a8ff";
  ctx.shadowBlur = gesture ? 25 * S : 0;
  ctx.beginPath();
  ctx.arc(46 * S, -66 * S, 10 * S, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGhost(g) {
  const { S } = shell;
  const y = g.y + Math.sin(g.t * 2.5) * 12 * S;
  const alpha = g.status === "dying" ? clamp(g.fade / 0.5, 0, 1) : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(g.x, y);
  const r = 42 * S;
  ctx.fillStyle = "rgba(235, 240, 255, 0.92)";
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI, 0);
  ctx.lineTo(r, r);
  for (let i = 0; i < 4; i++) {
    const x1 = r - ((i + 0.5) * 2 * r) / 4;
    const x2 = r - ((i + 1) * 2 * r) / 4;
    ctx.quadraticCurveTo(x1, r * (i % 2 ? 1.3 : 0.7), x2, r);
  }
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(-13 * S, -6 * S, 6 * S, 0, Math.PI * 2);
  ctx.arc(13 * S, -6 * S, 6 * S, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 14 * S, 8 * S, 10 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  // 咒語
  const n = g.runes.length;
  const gap = 46 * S;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect((-n * gap) / 2 - 6 * S, -r - 62 * S, n * gap + 12 * S, 50 * S);
  ctx.font = `${30 * S}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  g.runes.forEach((rn, i) => {
    ctx.globalAlpha = alpha * (i < g.done ? 0.25 : 1);
    ctx.fillText(GESTURES[rn], (-n * gap) / 2 + gap * (i + 0.5), -r - 37 * S);
  });
  ctx.restore();
}

function drawHud() {
  const { W, H, S } = shell;
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  shell.text("❤".repeat(Math.max(0, lives)) + "♡".repeat(MAX_LIVES - Math.max(0, lives)), 16, 60 * S, { align: "left" });
  // 目前手勢
  const cx = W / 2;
  const cy = H - 70 * S;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  ctx.arc(cx, cy, 46 * S, 0, Math.PI * 2);
  ctx.fill();
  if (gesture) {
    ctx.strokeStyle = needRelease ? "#888" : "#c9a8ff";
    ctx.lineWidth = 6 * S;
    ctx.beginPath();
    ctx.arc(cx, cy, 46 * S, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(gestureT / HOLD, 0, 1));
    ctx.stroke();
  }
  shell.text(gesture ? GESTURES[gesture] : "？", cx, cy + 2 * S, { size: 44 });
  shell.text("你的手勢", cx, cy - 64 * S, { size: 16 });
}

shell.loop((dt) => {
  shell.detect();
  readGesture(dt);
  if (state === "playing") update(dt);
  else shell.updateHoldStart(gesture === "Open_Palm", dt, "保持張開手掌");
  shell.fx.update(dt);

  shell.drawVideo();
  if (state === "playing") {
    drawWizard();
    for (const g of ghosts) drawGhost(g);
    for (const b of bolts) {
      ctx.fillStyle = "#c9a8ff";
      ctx.shadowColor = "#c9a8ff";
      ctx.shadowBlur = 30 * shell.S;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 16 * shell.S, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    shell.fx.draw();
    drawHud();
  }
});

shell.init();
