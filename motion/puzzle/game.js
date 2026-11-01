import { createShell, sound, dist, mid, smooth, DEBUG, HAND, handSize, isOpenPalm } from "../shared/shell.js";

const shell = createShell({
  title: "捏捏拼圖",
  model: "hand",
  dim: 0.6,
  help: [
    "📸 開始後倒數 3 秒，會把<b>你的照片</b>切成拼圖",
    "🤏 <b>拇指和食指捏起來</b>抓住拼圖，鬆開就放下",
    "🧩 放到正確位置附近會自動吸附",
    "⏱️ 共兩關（3×3、4×4），越快完成越好",
  ],
  hint: "✋ 張開手掌撐 1 秒即可開始",
  readyText: "準備好了！張開手掌撐 1 秒，或按「開始」",
});
const { ctx } = shell;

const LEVELS = [3, 4];
const SNAP = 0.3; // 距離正確位置小於格子寬的 30% 就吸附

let state = "menu"; // menu | snap | playing | clear
let level = 0;
let snapT = 0;
let photo = null; // 拍下的照片（正方形 canvas）
let pieces = [];
let held = null;
let elapsed = 0;
let clearT = 0;
let board = { x: 0, y: 0, size: 0 };
const cursor = { x: 0, y: 0, pinch: false, seen: false };

// 除錯模式：滑鼠按住 = 捏
if (DEBUG) {
  window.addEventListener("pointermove", (e) => Object.assign(cursor, { x: e.clientX, y: e.clientY, seen: true }));
  window.addEventListener("pointerdown", () => (cursor.pinch = true));
  window.addEventListener("pointerup", () => (cursor.pinch = false));
}

const sfx = {
  grab: () => sound.tone(500, { to: 700, type: "triangle", dur: 0.08, vol: 0.15 }),
  drop: () => sound.tone(300, { to: 220, type: "triangle", dur: 0.08, vol: 0.12 }),
  snap() {
    sound.tone(880, { type: "triangle", dur: 0.08, vol: 0.2 });
    sound.tone(1320, { type: "triangle", dur: 0.15, vol: 0.2, at: 0.06 });
  },
  shutter: () => sound.noise({ dur: 0.12, vol: 0.4, freq: 3000, type: "highpass" }),
  count: () => sound.tone(660, { dur: 0.1, vol: 0.15 }),
};

function start() {
  level = 0;
  elapsed = 0;
  shell.hideMenu();
  beginSnap();
  sound.sfx.start();
}
shell.onStart(start);

function beginSnap() {
  state = "snap";
  snapT = 3;
  lastCount = 4;
}
let lastCount = 4;

// 拍下鏡頭中間的正方形區域（鏡像，跟玩家看到的一樣）
function takePhoto() {
  const v = shell.video;
  const size = 600;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (v.readyState >= 2) {
    const s = Math.min(v.videoWidth, v.videoHeight);
    g.translate(size, 0);
    g.scale(-1, 1);
    g.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, size, size);
  } else {
    // 沒有鏡頭時畫一張彩色測試圖
    for (let i = 0; i < 6; i++) {
      g.fillStyle = `hsl(${i * 60}, 70%, 55%)`;
      g.fillRect(0, (i * size) / 6, size, size / 6);
    }
    g.fillStyle = "#fff";
    g.font = "bold 120px system-ui";
    g.textAlign = "center";
    g.fillText("🧩", size / 2, size / 2 + 40);
  }
  return c;
}

function layout() {
  const { W, H } = shell;
  const size = Math.min(W * 0.5, H * 0.72);
  board = { x: W * 0.06, y: (H - size) / 2 + 20 * shell.S, size };
}

function buildPieces() {
  layout();
  const n = LEVELS[level];
  const cell = board.size / n;
  const { W, H } = shell;
  const area = { x: board.x + board.size + cell * 0.4, y: H * 0.15, w: W - (board.x + board.size) - cell * 1.6, h: H * 0.75 - cell };
  pieces = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      pieces.push({
        r,
        c,
        x: area.x + Math.random() * Math.max(10, area.w),
        y: area.y + Math.random() * Math.max(10, area.h),
        locked: false,
      });
    }
  }
  // 打亂繪製順序
  pieces.sort(() => Math.random() - 0.5);
  held = null;
  state = "playing";
}

function readCursor() {
  if (DEBUG) return;
  const hands = shell.result?.landmarks ?? [];
  const h = hands[0];
  if (!h) {
    cursor.seen = false;
    return;
  }
  const p = shell.toScreen(mid(h[HAND.thumbTip], h[HAND.indexTip]));
  cursor.x = cursor.seen ? smooth(cursor.x, p.x, 0.6) : p.x;
  cursor.y = cursor.seen ? smooth(cursor.y, p.y, 0.6) : p.y;
  cursor.seen = true;
  // 捏合距離用手掌大小正規化，並加上遲滯避免抖動
  const ratio = dist(h[HAND.thumbTip], h[HAND.indexTip]) / handSize(h);
  if (!cursor.pinch && ratio < 0.3) cursor.pinch = true;
  else if (cursor.pinch && ratio > 0.5) cursor.pinch = false;
}

let wasPinch = false;
function updatePlaying(dt) {
  elapsed += dt;
  const n = LEVELS[level];
  const cell = board.size / n;

  if (cursor.pinch && !wasPinch && cursor.seen) {
    // 抓最上層、游標所在的拼圖
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.locked) continue;
      if (cursor.x >= p.x && cursor.x <= p.x + cell && cursor.y >= p.y && cursor.y <= p.y + cell) {
        held = { p, ox: cursor.x - p.x, oy: cursor.y - p.y };
        pieces.splice(i, 1);
        pieces.push(p);
        sfx.grab();
        break;
      }
    }
  }
  if (held && cursor.pinch) {
    held.p.x = cursor.x - held.ox;
    held.p.y = cursor.y - held.oy;
  }
  if (held && !cursor.pinch) {
    const p = held.p;
    const tx = board.x + p.c * cell;
    const ty = board.y + p.r * cell;
    if (Math.hypot(p.x - tx, p.y - ty) < cell * SNAP) {
      p.x = tx;
      p.y = ty;
      p.locked = true;
      shell.fx.burst(tx + cell / 2, ty + cell / 2, "#ffd447", 12, 200);
      sfx.snap();
    } else sfx.drop();
    held = null;
  }
  wasPinch = cursor.pinch;

  if (pieces.every((p) => p.locked)) {
    state = "clear";
    clearT = 2;
    sound.sfx.calibDone();
  }
}

function finish() {
  state = "menu";
  const t = Math.round(elapsed * 10) / 10;
  const best = shell.saveBest(t, true);
  shell.showMenu({
    title: "拼圖完成！",
    status: `總時間 ${t.toFixed(1)} 秒　最快 ${best.toFixed(1)} 秒`,
    result: `<p>兩關都完成了，張開手掌撐 1 秒再拍一張！</p>`,
  });
}

function drawBoard() {
  const n = LEVELS[level];
  const cell = board.size / n;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(board.x, board.y, board.size, board.size);
  ctx.globalAlpha = 0.18;
  ctx.drawImage(photo, board.x, board.y, board.size, board.size);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo(board.x + i * cell, board.y);
    ctx.lineTo(board.x + i * cell, board.y + board.size);
    ctx.moveTo(board.x, board.y + i * cell);
    ctx.lineTo(board.x + board.size, board.y + i * cell);
    ctx.stroke();
  }
  const src = photo.width / n;
  for (const p of pieces) {
    const lift = held?.p === p ? 6 * shell.S : 0;
    if (lift) {
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 20 * shell.S;
    }
    ctx.drawImage(photo, p.c * src, p.r * src, src, src, p.x - lift, p.y - lift, cell, cell);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = p.locked ? "rgba(91,227,125,0.6)" : "#fff";
    ctx.lineWidth = p.locked ? 1 : 2;
    ctx.strokeRect(p.x - lift, p.y - lift, cell, cell);
  }
}

function drawCursor() {
  if (!cursor.seen) return;
  const S = shell.S;
  ctx.strokeStyle = cursor.pinch ? "#ffd447" : "#fff";
  ctx.lineWidth = 4 * S;
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, (cursor.pinch ? 10 : 18) * S, 0, Math.PI * 2);
  ctx.stroke();
  if (cursor.pinch) {
    ctx.fillStyle = "#ffd447";
    ctx.fill();
  }
}

shell.loop((dt) => {
  shell.detect();
  readCursor();
  const { W, H, S } = shell;
  const hands = shell.result?.landmarks ?? [];

  if (state === "snap") {
    snapT -= dt;
    if (Math.ceil(snapT) !== lastCount && snapT > 0) {
      lastCount = Math.ceil(snapT);
      sfx.count();
    }
    if (snapT <= 0) {
      photo = takePhoto();
      sfx.shutter();
      buildPieces();
    }
  } else if (state === "playing") updatePlaying(dt);
  else if (state === "clear") {
    clearT -= dt;
    if (clearT <= 0) {
      level += 1;
      if (level < LEVELS.length) beginSnap();
      else finish();
    }
  } else shell.updateHoldStart(hands.some(isOpenPalm), dt, "保持張開手掌");
  shell.fx.update(dt);

  if (state === "snap") {
    shell.drawVideo(0);
    const s = Math.min(W, H) * 0.8;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4 * S;
    ctx.strokeRect((W - s) / 2, (H - s) / 2, s, s);
    shell.text(`第 ${level + 1} 關：擺個姿勢！`, W / 2, 50 * S, { size: 32, bold: true });
    shell.text(String(Math.max(1, Math.ceil(snapT))), W / 2, H / 2, { size: 160, bold: true, color: "rgba(255,255,255,0.85)" });
    return;
  }

  shell.drawVideo();
  if (state === "playing" || state === "clear") {
    drawBoard();
    shell.text(`第 ${level + 1} 關（${LEVELS[level]}×${LEVELS[level]}）`, 16, 30 * S, { align: "left", bold: true });
    shell.text(`⏱️ ${elapsed.toFixed(1)} 秒`, 16, 60 * S, { align: "left" });
    const done = pieces.filter((p) => p.locked).length;
    shell.text(`${done} / ${pieces.length}`, 16, 90 * S, { align: "left" });
    if (!cursor.seen && state === "playing") shell.text("把手舉到鏡頭前", W / 2, H - 40 * S, { size: 22, color: "#ffb3b3" });
    if (state === "clear") shell.banner("完成！", level + 1 < LEVELS.length ? "準備下一關…" : "全部完成！");
    shell.fx.draw();
  }
  drawCursor();
});

window.addEventListener("resize", () => {
  if (state !== "playing") return;
  // 視窗大小改變時，已放好的拼圖跟著棋盤移動
  const n = LEVELS[level];
  layout();
  const cell = board.size / n;
  for (const p of pieces) if (p.locked) Object.assign(p, { x: board.x + p.c * cell, y: board.y + p.r * cell });
});

shell.init();
