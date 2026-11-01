import { createShell, sound, pick, DEBUG } from "../shared/shell.js";
import { J, bodyGeom, drawSkeleton, POSES, poseMatch, drawTargetPose } from "../shared/pose.js";

const shell = createShell({
  title: "節奏舞步",
  model: "pose",
  dim: 0.4,
  help: [
    "🎵 跟著節拍，姿勢卡會從右邊滑到<b>判定線</b>",
    "🕺 卡片碰到判定線的那一拍，擺出卡片上的姿勢",
    "⭐ 相似度 80% 以上 PERFECT、60% 以上 GOOD",
    "📏 離鏡頭約 2 公尺，上半身和雙手要入鏡，一首歌約 60 秒",
  ],
  hint: "🙌 雙手舉高過頭撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高過頭 1 秒，或按「開始」",
});
const { ctx } = shell;

const BPM = 100;
const BEAT = 60 / BPM;
const CARD_EVERY = 4; // 每 4 拍一張卡
const LEAD = 4; // 卡片提前幾拍出現
const CARDS = 22;
const WINDOW = 0.35; // 判定窗口（秒），取窗口內最高相似度
// 只用不需要腳的姿勢，站位比較容易
const DANCE_POSES = POSES.filter((p) => p.lThigh == null);

let state = "menu";
let t = 0; // 歌曲時間
let beatNo = -1;
let cards = [];
let geom = null;
let match = 0;
let score = 0;
let combo = 0;
let maxCombo = 0;
let counts = {};

const sfx = {
  kick: () => sound.tone(150, { to: 45, type: "sine", dur: 0.18, vol: 0.45 }),
  hat: (at) => sound.noise({ dur: 0.04, vol: 0.12, freq: 7000, type: "highpass", at }),
  bass: (f) => sound.tone(f, { type: "triangle", dur: BEAT * 0.8, vol: 0.16 }),
  perfect: () => sound.arpeggio([1047, 1319], 0.05, { type: "triangle", dur: 0.12, vol: 0.18 }),
  good: () => sound.tone(880, { type: "triangle", dur: 0.12, vol: 0.15 }),
  miss: () => sound.tone(200, { to: 150, type: "square", dur: 0.12, vol: 0.1 }),
};
const BASSLINE = [110, 110, 130.8, 98, 87.3, 87.3, 98, 123.5];

function start() {
  state = "playing";
  t = -BEAT * 2; // 先給兩拍準備
  beatNo = -3;
  score = 0;
  combo = 0;
  maxCombo = 0;
  counts = { PERFECT: 0, GOOD: 0, MISS: 0 };
  let last = null;
  cards = Array.from({ length: CARDS }, (_, i) => {
    const pose = pick(DANCE_POSES.filter((p) => p !== last));
    last = pose;
    return { pose, hitAt: (LEAD + i * CARD_EVERY) * BEAT, best: 0, judged: null, showT: 0 };
  });
  shell.fx.clear();
  shell.hideMenu();
  sound.sfx.start();
}

function end() {
  state = "menu";
  const best = shell.saveBest(score);
  const ratio = (counts.PERFECT + counts.GOOD * 0.5) / CARDS;
  const rank = ratio >= 0.9 ? "S" : ratio >= 0.75 ? "A" : ratio >= 0.5 ? "B" : "C";
  shell.showMenu({
    title: `評價 ${rank}`,
    status: `分數 ${score}　最高 ${best}`,
    result:
      `<table><tr><td>⭐ PERFECT</td><td>${counts.PERFECT}</td></tr>` +
      `<tr><td>👍 GOOD</td><td>${counts.GOOD}</td></tr>` +
      `<tr><td>❌ MISS</td><td>${counts.MISS}</td></tr>` +
      `<tr><td>最高連擊</td><td>${maxCombo}</td></tr></table>`,
  });
  sound.sfx.gameOver();
}
shell.onStart(start);

let spaceDown = false;
if (DEBUG) {
  window.addEventListener("keydown", (e) => e.code === "Space" && (spaceDown = true));
  window.addEventListener("keyup", (e) => e.code === "Space" && (spaceDown = false));
}

function update(dt) {
  t += dt;
  // 節拍：每拍大鼓、反拍小鈸、每拍一個低音
  const b = Math.floor(t / BEAT);
  if (b !== beatNo) {
    beatNo = b;
    sfx.kick();
    sfx.hat(BEAT / 2);
    if (b >= 0) sfx.bass(BASSLINE[Math.floor(b / 2) % BASSLINE.length]);
  }

  match = DEBUG ? (spaceDown ? 0.9 : 0.2) : geom?.upper ? poseMatch(geom, cards.find((c) => !c.judged)?.pose ?? {}) : 0;
  for (const c of cards) {
    if (c.judged) {
      c.showT -= dt;
      continue;
    }
    if (Math.abs(t - c.hitAt) <= WINDOW) c.best = Math.max(c.best, DEBUG ? match : geom?.upper ? poseMatch(geom, c.pose) : 0);
    if (t > c.hitAt + WINDOW) judge(c);
  }
  if (t > cards[cards.length - 1].hitAt + 1.5) end();
}

function judge(c) {
  const j = c.best >= 0.8 ? "PERFECT" : c.best >= 0.6 ? "GOOD" : "MISS";
  c.judged = j;
  c.showT = 0.8;
  counts[j] += 1;
  if (j === "MISS") {
    combo = 0;
    sfx.miss();
  } else {
    combo += 1;
    maxCombo = Math.max(maxCombo, combo);
    score += (j === "PERFECT" ? 100 : 50) * (1 + Math.floor(combo / 10));
    if (j === "PERFECT") sfx.perfect();
    else sfx.good();
    shell.fx.burst(lineX(), shell.H * 0.5, j === "PERFECT" ? "#ffd447" : "#59c8ff", 24, 400);
  }
}

const lineX = () => shell.W * 0.18;

function drawTrack() {
  const { W, H, S } = shell;
  const y = H * 0.5;
  const span = W - lineX();
  // 判定線（隨節拍閃爍）
  const pulse = 1 - ((t / BEAT) % 1);
  ctx.strokeStyle = `rgba(255, 212, 71, ${0.5 + pulse * 0.5})`;
  ctx.lineWidth = (4 + pulse * 6) * S;
  ctx.beginPath();
  ctx.moveTo(lineX(), y - 120 * S);
  ctx.lineTo(lineX(), y + 120 * S);
  ctx.stroke();

  for (const c of cards) {
    if (c.judged && c.showT <= 0) continue;
    const ahead = (c.hitAt - t) / (LEAD * BEAT); // 1 = 剛出現，0 = 在判定線上
    if (ahead > 1.05) continue;
    const x = lineX() + span * Math.max(0, ahead);
    const size = 200 * S;
    ctx.fillStyle = c.judged ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.55)";
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    drawTargetPose(shell, c.pose, x, y - size * 0.22, size * 0.2, c.judged ? "rgba(255,255,255,0.3)" : "#fff", 5);
    shell.text(c.pose.name, x, y + size / 2 - 16 * S, { size: 16 });
    if (c.judged) {
      const col = { PERFECT: "#ffd447", GOOD: "#59c8ff", MISS: "#ff5b5b" }[c.judged];
      shell.text(c.judged, x, y - size / 2 - 24 * S, { size: 28, bold: true, color: col });
    }
  }
}

function drawHud() {
  const { W, H, S } = shell;
  shell.text(`分數 ${score}`, 16, 30 * S, { align: "left", bold: true });
  if (combo >= 3) shell.text(`${combo} 連擊！`, 16, 62 * S, { align: "left", bold: true, color: "#ffd447", size: 26 });
  const total = cards[cards.length - 1].hitAt + 1.5;
  shell.bar(0, H - 6 * S, W, 6 * S, t / total, "#ff7b54");
  shell.bar(W / 2 - 120 * S, 30 * S, 240 * S, 10 * S, match, match >= 0.8 ? "#ffd447" : match >= 0.6 ? "#59c8ff" : "#888");
  shell.text(`目前相似度 ${Math.round(match * 100)}%`, W / 2, 56 * S, { size: 16 });
  if (t < 0) shell.banner("準備…", "跟著節拍擺姿勢！");
}

shell.loop((dt) => {
  const res = shell.detect();
  const lm = res?.landmarks?.[0];
  geom = lm ? bodyGeom(shell, lm) : null;

  if (state === "playing") update(dt);
  else {
    const up = geom && geom.p[J.lw].y < geom.p[J.nose].y && geom.p[J.rw].y < geom.p[J.nose].y;
    shell.updateHoldStart(up, dt, "保持舉手");
  }
  shell.fx.update(dt);

  shell.drawVideo();
  if (geom) drawSkeleton(shell, geom, state === "playing" ? (match >= 0.8 ? "#ffd447" : "#59c8ff") : "rgba(255,255,255,0.6)");
  if (state === "playing") {
    drawTrack();
    drawHud();
    shell.fx.draw();
    if (!DEBUG && !geom?.upper && t > 0) shell.text("看不到上半身，請退後一點", shell.W / 2, shell.H - 40 * shell.S, { color: "#ffb3b3" });
  }
});

shell.init();
