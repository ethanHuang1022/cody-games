import { createShell, sound, clamp, lerp, pick, DEBUG } from "../shared/shell.js";
import { J, bodyGeom, drawSkeleton, POSES, poseMatch, drawTargetPose } from "../shared/pose.js";

const shell = createShell({
  title: "人形牆",
  model: "pose",
  dim: 0.35,
  help: [
    "🧱 牆上挖了一個<b>人形洞</b>，牆會慢慢朝你壓過來",
    "🕺 在牆到之前擺出跟洞一樣的姿勢，<b>相似度 70%</b> 以上就能穿過去",
    "📏 離鏡頭約 2 公尺，至少要讓<b>上半身和手</b>完整入鏡（有些姿勢要腳）",
    "💔 卡住會扣一顆心，共 3 顆，牆會越來越快",
  ],
  hint: "🙌 雙手舉高過頭撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高過頭 1 秒，或按「開始」",
});
const { ctx } = shell;

const PASS = 0.7;
const MAX_LIVES = 3;

let state = "menu"; // menu | playing | result
let lives = 0;
let score = 0;
let passed = 0;
let wallNo = 0;
let wall = null; // { pose, t, dur }
let geom = null;
let match = 0;
let bestMatch = 0;
let resultT = 0;
let lastResult = null;
let lastPose = null;
const wallCanvas = document.createElement("canvas");

const sfx = {
  pass() {
    sound.arpeggio([523, 659, 784, 1047], 0.06, { type: "triangle", dur: 0.18, vol: 0.2 });
  },
  crash() {
    sound.noise({ dur: 0.6, vol: 0.6, freq: 700, to: 60 });
    sound.tone(120, { to: 40, type: "square", dur: 0.4, vol: 0.2 });
  },
  rumble: () => sound.noise({ dur: 0.25, vol: 0.12, freq: 200, to: 120 }),
};

function start() {
  state = "playing";
  lives = MAX_LIVES;
  score = 0;
  passed = 0;
  wallNo = 0;
  shell.fx.clear();
  shell.hideMenu();
  nextWall();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  shell.showMenu({
    title: "被牆推倒了！",
    status: `分數 ${score}　最高 ${best}`,
    result: `<p>穿過 <b>${passed}</b> 面牆</p>`,
  });
  sound.sfx.gameOver();
}
shell.onStart(start);

function nextWall() {
  wallNo += 1;
  const pose = pick(POSES.filter((p) => p !== lastPose));
  lastPose = pose;
  wall = { pose, t: 0, dur: clamp(6 - wallNo * 0.25, 3, 6), lastSec: 99 };
  bestMatch = 0;
  state = "playing";
}

// 洞的位置：跟著玩家的肩膀與身高，沒有人時放在畫面中央
function holeAnchor() {
  if (geom?.upper) return { x: geom.sh.x, y: geom.sh.y, T: geom.T };
  return { x: shell.W / 2, y: shell.H * 0.38, T: shell.H * 0.22 };
}

function update(dt) {
  if (state === "result") {
    resultT -= dt;
    if (resultT <= 0) {
      if (lives <= 0) end();
      else nextWall();
    }
    return;
  }
  const needLegs = wall.pose.lThigh != null;
  const ok = DEBUG || (needLegs ? geom?.full : geom?.upper);
  if (!ok) return; // 身體不在畫面中就暫停
  match = DEBUG ? (spaceDown ? 0.95 : 0.3) : poseMatch(geom, wall.pose);
  wall.t += dt / wall.dur;
  // 最後 25% 的時間裡取最高相似度，避免剛好在最後一幀抖到
  if (wall.t > 0.75) bestMatch = Math.max(bestMatch, match);
  const sec = Math.ceil((1 - wall.t) * wall.dur);
  if (sec !== wall.lastSec && sec <= 3) {
    wall.lastSec = sec;
    sfx.rumble();
  }
  if (wall.t >= 1) {
    const ok = bestMatch >= PASS;
    lastResult = { ok, m: bestMatch };
    if (ok) {
      passed += 1;
      const gain = Math.round(100 * bestMatch);
      score += gain;
      shell.fx.burst(shell.W / 2, shell.H / 2, "#5be37d", 40, 500);
      sfx.pass();
    } else {
      lives -= 1;
      sfx.crash();
    }
    state = "result";
    resultT = 1.5;
  }
}

let spaceDown = false;
if (DEBUG) {
  window.addEventListener("keydown", (e) => e.code === "Space" && (spaceDown = true));
  window.addEventListener("keyup", (e) => e.code === "Space" && (spaceDown = false));
}

// 把牆（含人形洞）畫在離屏畫布，再依距離縮放貼到畫面上
function drawWall() {
  const { W, H, S } = shell;
  wallCanvas.width = W;
  wallCanvas.height = H;
  const g = wallCanvas.getContext("2d");
  g.fillStyle = "#b5643c";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(0,0,0,0.25)";
  g.lineWidth = 3;
  const bh = 40 * S;
  for (let y = 0, row = 0; y < H; y += bh, row++) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    for (let x = (row % 2) * bh; x < W; x += bh * 2) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + bh);
      g.stroke();
    }
  }
  const a = holeAnchor();
  g.globalCompositeOperation = "destination-out";
  const fakeShell = { ctx: g, S };
  drawTargetPose(fakeShell, wall.pose, a.x, a.y, a.T, "#000", 46 * (a.T / (H * 0.22)));
  g.globalCompositeOperation = "source-over";

  // 越近越大、越不透明
  const k = clamp(wall.t, 0, 1);
  const scale = lerp(0.25, 1, k * k);
  ctx.save();
  ctx.globalAlpha = lerp(0.55, 0.92, k);
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(wallCanvas, -W / 2, -H / 2);
  ctx.restore();
}

function drawHud() {
  const { W, H, S } = shell;
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  shell.text("❤".repeat(Math.max(0, lives)) + "♡".repeat(MAX_LIVES - Math.max(0, lives)), 16, 60 * S, { align: "left" });
  shell.text(`第 ${wallNo} 面牆`, 16, 90 * S, { align: "left" });
  shell.text(`${wall.pose.icon} ${wall.pose.name}`, W / 2, 40 * S, { size: 34, bold: true });
  const col = match >= PASS ? "#5be37d" : "#ffd447";
  shell.bar(W / 2 - 150 * S, 66 * S, 300 * S, 12 * S, match, col);
  ctx.fillStyle = "#fff";
  ctx.fillRect(W / 2 - 150 * S + 300 * S * PASS, 62 * S, 2, 20 * S);
  shell.text(`相似度 ${Math.round(match * 100)}%`, W / 2, 96 * S, { size: 18 });
  if (state === "playing") {
    const sec = Math.max(0, (1 - wall.t) * wall.dur);
    shell.text(sec.toFixed(1), W - 60 * S, H - 50 * S, { size: 40, bold: true, color: sec < 1.5 ? "#ff5b5b" : "#fff" });
  }
}

shell.loop((dt) => {
  const res = shell.detect();
  const lm = res?.landmarks?.[0];
  geom = lm ? bodyGeom(shell, lm) : null;

  if (state === "playing" || state === "result") update(dt);
  else {
    const up = geom && geom.p[J.lw].y < geom.p[J.nose].y && geom.p[J.rw].y < geom.p[J.nose].y;
    shell.updateHoldStart(up, dt, "保持舉手");
  }
  shell.fx.update(dt);

  shell.drawVideo();
  if (state === "playing" || state === "result") {
    drawWall();
    if (geom) drawSkeleton(shell, geom, match >= PASS ? "#5be37d" : "#ffd447");
    drawHud();
    shell.fx.draw();
    if (state === "result") {
      shell.banner(lastResult.ok ? "穿過去了！" : "卡住了！", `最高相似度 ${Math.round(lastResult.m * 100)}%`);
    } else if (!DEBUG && !(wall.pose.lThigh != null ? geom?.full : geom?.upper)) {
      shell.banner("暫停中", wall.pose.lThigh != null ? "這個姿勢要全身入鏡，請退後一點" : "請讓上半身和雙手入鏡");
    }
  } else if (geom) drawSkeleton(shell, geom, "rgba(255,255,255,0.6)");
});

shell.init();
