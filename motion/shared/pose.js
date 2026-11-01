// 全身姿勢共用工具：關節編號、身體幾何、骨架繪製、姿勢比對
import { dist, mid, clamp } from "./shell.js";

// MediaPipe Pose 關節編號（左右是玩家自己的左右；畫面鏡像後玩家的左手在畫面左邊）
export const J = {
  nose: 0,
  ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
  lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28,
};
export const LEG_POINTS = [J.lh, J.rh, J.lk, J.rk, J.la, J.ra];
export const UPPER_POINTS = [J.ls, J.rs, J.le, J.re, J.lw, J.rw];
export const BONES = [
  [J.ls, J.rs], [J.ls, J.le], [J.le, J.lw], [J.rs, J.re], [J.re, J.rw],
  [J.ls, J.lh], [J.rs, J.rh], [J.lh, J.rh],
  [J.lh, J.lk], [J.lk, J.la], [J.rh, J.rk], [J.rk, J.ra],
];

const visible = (p) => p.v > 0.5 && p.ny > -0.02 && p.ny < 1.02;

/**
 * 把 MediaPipe 關節點轉成螢幕座標的身體幾何
 * p[i] = { x, y（螢幕座標）, v（可見度）, ny（原始 0~1 的 y） }
 */
export function bodyGeom(shell, lm) {
  const p = lm.map((l) => ({ ...shell.toScreen(l), v: l.visibility ?? 1, ny: l.y }));
  const sh = mid(p[J.ls], p[J.rs]);
  const hip = mid(p[J.lh], p[J.rh]);
  return {
    p,
    sh,
    hip,
    T: Math.max(20, dist(sh, hip)), // 軀幹長（像素），距離都用它正規化
    sw: Math.max(10, dist(p[J.ls], p[J.rs])),
    upper: UPPER_POINTS.every((i) => visible(p[i])),
    full: [...UPPER_POINTS, ...LEG_POINTS].every((i) => visible(p[i])),
  };
}

export function drawSkeleton(shell, geom, color = "#fff", width = 6) {
  const { ctx, S } = shell;
  const { p } = geom;
  ctx.lineCap = "round";
  ctx.lineWidth = width * S;
  ctx.strokeStyle = color;
  for (const [a, b] of BONES) {
    if (p[a].v < 0.4 || p[b].v < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(p[a].x, p[a].y);
    ctx.lineTo(p[b].x, p[b].y);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of [J.nose, ...UPPER_POINTS, ...LEG_POINTS]) {
    if (p[i].v < 0.4) continue;
    ctx.beginPath();
    ctx.arc(p[i].x, p[i].y, width * 0.8 * S, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- 姿勢比對 ----------
// 每段肢體用螢幕上的方向角定義：0° 往右、90° 往下、180° 往左、270° 往上
// 「左手」是玩家自己的左手（在鏡像畫面的左邊）

const LIMBS = {
  lUpper: [J.ls, J.le], lFore: [J.le, J.lw],
  rUpper: [J.rs, J.re], rFore: [J.re, J.rw],
  lThigh: [J.lh, J.lk], lShin: [J.lk, J.la],
  rThigh: [J.rh, J.rk], rShin: [J.rk, J.ra],
};

export const POSES = [
  { name: "Y 字", icon: "🙌", lUpper: 225, lFore: 225, rUpper: 315, rFore: 315 },
  { name: "T 字", icon: "✈️", lUpper: 180, lFore: 180, rUpper: 0, rFore: 0 },
  { name: "投降", icon: "🙆", lUpper: 180, lFore: 270, rUpper: 0, rFore: 270 },
  { name: "舉左手", icon: "🙋", lUpper: 270, lFore: 270, rUpper: 90, rFore: 90 },
  { name: "舉右手", icon: "🙋", lUpper: 90, lFore: 90, rUpper: 270, rFore: 270 },
  { name: "斜線 ╱", icon: "↗️", lUpper: 135, lFore: 135, rUpper: 315, rFore: 315 },
  { name: "斜線 ╲", icon: "↖️", lUpper: 225, lFore: 225, rUpper: 45, rFore: 45 },
  { name: "大字", icon: "⭐", lUpper: 210, lFore: 210, rUpper: 330, rFore: 330, lThigh: 112, lShin: 112, rThigh: 68, rShin: 68 },
  { name: "叉腰", icon: "💪", lUpper: 115, lFore: 45, rUpper: 65, rFore: 135 },
  { name: "大力士", icon: "🏋️", lUpper: 180, lFore: 270, rUpper: 0, rFore: 270, lThigh: 112, lShin: 90, rThigh: 68, rShin: 90 },
];

function limbDir(p, [a, b]) {
  return (Math.atan2(p[b].y - p[a].y, p[b].x - p[a].x) * 180) / Math.PI;
}

function angDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

/** 回傳 0~1 的相似度：每段肢體誤差 15° 以內滿分，60° 以上零分 */
export function poseMatch(geom, target) {
  let sum = 0;
  let wsum = 0;
  for (const [k, seg] of Object.entries(LIMBS)) {
    if (target[k] == null) continue;
    const w = k.includes("Thigh") || k.includes("Shin") ? 0.6 : 1;
    const ok = geom.p[seg[0]].v > 0.4 && geom.p[seg[1]].v > 0.4;
    const s = ok ? clamp(1 - (angDiff(limbDir(geom.p, seg), target[k]) - 15) / 45, 0, 1) : 0;
    sum += s * w;
    wsum += w;
  }
  return wsum ? sum / wsum : 0;
}

/** 以 (cx, cy) 為肩膀中心、T 為軀幹長，畫出目標姿勢的火柴人 */
export function drawTargetPose(shell, target, cx, cy, T, color = "#fff", width = 10) {
  const { ctx, S } = shell;
  const rad = (d) => (d * Math.PI) / 180;
  const go = (from, deg, len) => ({ x: from.x + Math.cos(rad(deg)) * len, y: from.y + Math.sin(rad(deg)) * len });
  const ls = { x: cx - T * 0.35, y: cy };
  const rs = { x: cx + T * 0.35, y: cy };
  const lh = { x: cx - T * 0.2, y: cy + T };
  const rh = { x: cx + T * 0.2, y: cy + T };
  const le = go(ls, target.lUpper ?? 100, T * 0.55);
  const lw = go(le, target.lFore ?? 95, T * 0.5);
  const re = go(rs, target.rUpper ?? 80, T * 0.55);
  const rw = go(re, target.rFore ?? 85, T * 0.5);
  const lk = go(lh, target.lThigh ?? 92, T * 0.8);
  const la = go(lk, target.lShin ?? 90, T * 0.8);
  const rk = go(rh, target.rThigh ?? 88, T * 0.8);
  const ra = go(rk, target.rShin ?? 90, T * 0.8);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width * S;
  ctx.strokeStyle = color;
  const line = (...pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
    ctx.stroke();
  };
  line(lw, le, ls, rs, re, rw);
  line(ls, lh, rh, rs);
  line(la, lk, lh);
  line(ra, rk, rh);
  ctx.beginPath();
  ctx.arc(cx, cy - T * 0.45, T * 0.25, 0, Math.PI * 2);
  ctx.stroke();
}
