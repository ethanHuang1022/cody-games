import { createShell, sound, DEBUG } from "../shared/shell.js";
import { J, bodyGeom, drawSkeleton } from "../shared/pose.js";

const shell = createShell({
  title: "雙人拔河",
  model: "pose",
  modelOptions: { numPoses: 2 },
  dim: 0.35,
  help: [
    "👥 兩個人<b>並排</b>站在鏡頭前，左邊是 🔵 藍隊、右邊是 🔴 紅隊",
    "🙌➡️👇 雙手<b>舉過頭再拉到肩膀以下</b>，就算拉一下繩子",
    "🏁 誰先把中間的旗子拉到自己的線就贏了",
    "📏 離鏡頭約 2～3 公尺，兩個人的上半身和雙手都要入鏡",
  ],
  hint: "🙌 任何一人雙手舉高過頭撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高過頭 1 秒，或按「開始」",
});
const { ctx } = shell;

const STEP = 0.1; // 每拉一下移動多少（-1 ~ 1）
const TEAMS = [
  { name: "藍隊", color: "#59c8ff" },
  { name: "紅隊", color: "#ff5b5b" },
];

let state = "menu"; // menu | countdown | playing | win
let countT = 0;
let rope = 0; // -1 = 藍隊贏、1 = 紅隊贏
let ropeShown = 0;
let players = []; // 依畫面左右排序的身體幾何
let pulls = [0, 0];
let armed = [false, false];
let winner = -1;
let winT = 0;
let elapsed = 0;
let lastCount = 99;

if (DEBUG) {
  window.addEventListener("keydown", (e) => {
    if (state !== "playing") return;
    if (e.code === "KeyA") pull(0);
    if (e.code === "KeyL") pull(1);
  });
}

const sfx = {
  pull: (i) => sound.noise({ dur: 0.15, vol: 0.25, freq: i ? 900 : 600, to: 200 }),
  count: () => sound.tone(660, { dur: 0.12, vol: 0.18 }),
  go: () => sound.tone(1320, { dur: 0.3, vol: 0.2 }),
  win: () => sound.arpeggio([523, 659, 784, 1047, 784, 1047], 0.1, { type: "triangle", dur: 0.2, vol: 0.22 }),
};

function start() {
  state = "countdown";
  countT = 3;
  lastCount = 99;
  rope = 0;
  ropeShown = 0;
  pulls = [0, 0];
  armed = [false, false];
  winner = -1;
  elapsed = 0;
  shell.fx.clear();
  shell.hideMenu();
}
shell.onStart(start);

function pull(i) {
  pulls[i] += 1;
  rope += i === 0 ? -STEP : STEP;
  sfx.pull(i);
  const { W, H } = shell;
  shell.fx.burst(W / 2 + ropeShown * W * 0.35, H * 0.8, TEAMS[i].color, 8, 200);
  if (Math.abs(rope) >= 1 - 1e-6) {
    winner = rope < 0 ? 0 : 1;
    state = "win";
    winT = 2.5;
    sfx.win();
  }
}

function readPlayers() {
  const lms = shell.result?.landmarks ?? [];
  players = lms.map((lm) => bodyGeom(shell, lm)).sort((a, b) => a.sh.x - b.sh.x);
}

// 舉手 → 拉下 = 一次
function detectPulls() {
  if (players.length < 2) return;
  players.forEach((g, i) => {
    if (!g.upper) return;
    const wy = (g.p[J.lw].y + g.p[J.rw].y) / 2;
    if (!armed[i] && wy < g.p[J.nose].y) armed[i] = true;
    else if (armed[i] && wy > g.sh.y + g.T * 0.15) {
      armed[i] = false;
      pull(i);
    }
  });
}

function finish() {
  state = "menu";
  shell.showMenu({
    title: `${TEAMS[winner].name}獲勝！`,
    status: "雙手舉高 1 秒再比一場",
    result:
      `<table><tr><td>🔵 藍隊</td><td>拉了 ${pulls[0]} 下</td></tr>` +
      `<tr><td>🔴 紅隊</td><td>拉了 ${pulls[1]} 下</td></tr>` +
      `<tr><td>⏱️ 比賽時間</td><td>${elapsed.toFixed(1)} 秒</td></tr></table>`,
  });
}

function drawRope() {
  const { W, H, S } = shell;
  const y = H * 0.8;
  const cx = W / 2 + ropeShown * W * 0.35;
  // 兩邊的勝利線
  for (const [i, x] of [[0, W / 2 - W * 0.35], [1, W / 2 + W * 0.35]]) {
    ctx.fillStyle = TEAMS[i].color;
    ctx.fillRect(x - 3 * S, y - 60 * S, 6 * S, 120 * S);
    shell.text(TEAMS[i].name, x, y - 76 * S, { size: 20, bold: true, color: TEAMS[i].color });
  }
  // 繩子（輕微晃動）
  ctx.strokeStyle = "#d9b47a";
  ctx.lineWidth = 10 * S;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 20) {
    const yy = y + Math.sin(x * 0.03 + performance.now() / 150) * 2 * S;
    if (x === 0) ctx.moveTo(x, yy);
    else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  // 中間旗子
  ctx.fillStyle = "#fff";
  ctx.fillRect(cx - 3 * S, y - 70 * S, 6 * S, 70 * S);
  ctx.fillStyle = "#ffd447";
  ctx.beginPath();
  ctx.moveTo(cx + 3 * S, y - 70 * S);
  ctx.lineTo(cx + 50 * S, y - 55 * S);
  ctx.lineTo(cx + 3 * S, y - 40 * S);
  ctx.fill();
}

function drawHud() {
  const { W, S } = shell;
  shell.text(`🔵 ${pulls[0]}`, 24, 84 * S, { align: "left", bold: true, size: 30, color: TEAMS[0].color });
  shell.text(`${pulls[1]} 🔴`, W - 24, 84 * S, { align: "right", bold: true, size: 30, color: TEAMS[1].color });
}

shell.loop((dt) => {
  shell.detect();
  readPlayers();
  const { W, H } = shell;
  const ready = DEBUG || (players.length >= 2 && players.every((g) => g.upper));

  if (state === "countdown") {
    if (ready) {
      countT -= dt;
      const c = Math.ceil(countT);
      if (c !== lastCount && c > 0) {
        lastCount = c;
        sfx.count();
      }
      if (countT <= 0) {
        state = "playing";
        sfx.go();
        // 開始時雙手若已經舉著，不算一下
        armed = [false, false];
      }
    }
  } else if (state === "playing") {
    if (ready) {
      elapsed += dt;
      if (!DEBUG) detectPulls();
    }
  } else if (state === "win") {
    winT -= dt;
    if (winT <= 0) finish();
  } else {
    const up = players.some((g) => g.p[J.lw].y < g.p[J.nose].y && g.p[J.rw].y < g.p[J.nose].y);
    shell.updateHoldStart(up, dt, "保持舉手");
  }
  ropeShown += (rope - ropeShown) * Math.min(1, dt * 8);
  shell.fx.update(dt);

  shell.drawVideo();
  // 中線
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
  players.slice(0, 2).forEach((g, i) => drawSkeleton(shell, g, players.length >= 2 ? TEAMS[i].color : "#fff"));

  if (state !== "menu") {
    drawRope();
    drawHud();
    shell.fx.draw();
  }
  if (state === "countdown") {
    if (ready) shell.text(String(Math.max(1, Math.ceil(countT))), W / 2, H * 0.4, { size: 140, bold: true });
    else shell.banner(`需要兩個人（目前 ${players.length} 人）`, "兩個人並排站好，上半身和雙手都要入鏡");
  }
  if (state === "playing" && !ready) shell.banner("暫停中", `看不到兩個人的上半身（目前 ${players.length} 人）`);
  if (state === "playing" && elapsed < 0.8) shell.text("拉！", W / 2, H * 0.4, { size: 120, bold: true, color: "#ffd447" });
  if (state === "win") shell.banner(`${TEAMS[winner].name}獲勝！🎉`, `拉了 ${pulls[winner]} 下`);
});

shell.init();
