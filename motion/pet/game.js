import { createShell, sound, clamp, rand, pick, dist, DEBUG } from "../shared/shell.js";
import { J, bodyGeom } from "../shared/pose.js";

const shell = createShell({
  title: "肩上寵物",
  model: "pose",
  dim: 0,
  help: [
    "🐣 小麻糬會<b>坐在你的右肩上</b>，跟著你移動",
    "🤚 用<b>左手</b>在牠身邊來回摸摸，牠會很開心",
    "🍎 抓住從天上掉下來的食物，<b>拿到牠旁邊</b>就會吃掉",
    "🦘 你<b>跳一下</b>牠也會跟著跳！餵越多長越大，進度會自動保存",
  ],
  hint: "🙌 雙手舉高過頭撐 1 秒即可開始",
  readyText: "準備好了！雙手舉高過頭 1 秒，或按「開始」",
});
const { ctx } = shell;

const FOODS = ["🍎", "🍓", "🐟", "🍙", "🧁", "🍌"];
const STAGES = [
  { name: "麻糬寶寶", color: "#fff3e6", size: 1 },
  { name: "麻糬小孩", color: "#ffe1ec", size: 1.25 },
  { name: "麻糬少年", color: "#e3f4ff", size: 1.5 },
  { name: "麻糬大王", color: "#fff1b8", size: 1.8, crown: true },
];
const SAVE_KEY = "pet-mochi";

let state = "menu";
let geom = null;
let pet = { x: 0, y: 0, vx: 0, vy: 0, hop: 0, spin: 0, blink: 0, mood: 0.6 };
let save = loadSave();
let foods = [];
let held = [null, null]; // 左右手拿著的食物
let hearts = [];
let spawnT = 2;
let pettingT = 0;
let lastHand = null;
let baseHip = null;
let message = "";
let messageT = 0;

function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && typeof s.fed === "number") return s;
  } catch { /* 沒存過 */ }
  return { fed: 0, pets: 0 };
}
function writeSave() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* 忽略 */ }
}
const stage = () => STAGES[Math.min(STAGES.length - 1, Math.floor(save.fed / 6))];

// 除錯模式：滑鼠當手、按住左鍵抓東西、空白鍵跳
let mouse = null;
if (DEBUG) {
  window.addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }));
  window.addEventListener("keydown", (e) => e.code === "Space" && (pet.hop = 0.6));
}

const sfx = {
  purr: () => sound.tone(rand(180, 220), { to: 160, type: "triangle", dur: 0.25, vol: 0.08 }),
  grab: () => sound.tone(600, { to: 900, type: "triangle", dur: 0.08, vol: 0.12 }),
  eat() {
    sound.tone(400, { to: 300, type: "square", dur: 0.06, vol: 0.08 });
    sound.tone(450, { to: 320, type: "square", dur: 0.06, vol: 0.08, at: 0.1 });
    sound.arpeggio([784, 988, 1175], 0.06, { type: "triangle", dur: 0.12, vol: 0.15, at: 0.25 });
  },
  hop: () => sound.tone(400, { to: 900, type: "sine", dur: 0.15, vol: 0.15 }),
  grow: () => sound.arpeggio([523, 659, 784, 1047, 1319], 0.08, { type: "triangle", dur: 0.25, vol: 0.2 }),
};

function start() {
  state = "playing";
  foods = [];
  held = [null, null];
  baseHip = null;
  pet.x = shell.W / 2;
  pet.y = shell.H / 2;
  shell.hideMenu();
  say(`${stage().name}來了！`);
  sound.sfx.start();
}
shell.onStart(start);

function say(text) {
  message = text;
  messageT = 2.5;
}

// 寵物的家：玩家右肩上方（右肩在畫面右邊）
function home() {
  if (geom?.upper) {
    const s = geom.p[J.rs];
    return { x: s.x + geom.T * 0.1, y: s.y - geom.T * 0.32 * stage().size };
  }
  return { x: shell.W / 2, y: shell.H * 0.4 };
}

function hands() {
  if (DEBUG && mouse) return [mouse, null];
  if (!geom) return [null, null];
  const h = (i) => (geom.p[i].v > 0.5 ? geom.p[i] : null);
  return [h(J.lw), h(J.rw)];
}

function update(dt) {
  const { W, H, S } = shell;
  const T = geom?.T ?? H * 0.2;
  const target = home();
  // 彈簧跟隨，看起來有重量感
  pet.vx += (target.x - pet.x) * 60 * dt;
  pet.vy += (target.y - pet.y) * 60 * dt;
  pet.vx *= Math.pow(0.0005, dt);
  pet.vy *= Math.pow(0.0005, dt);
  pet.x += pet.vx * dt;
  pet.y += pet.vy * dt;
  pet.hop = Math.max(0, pet.hop - dt);
  pet.spin = Math.max(0, pet.spin - dt);
  pet.blink -= dt;
  if (pet.blink < -3) pet.blink = 0.15;
  pet.mood = clamp(pet.mood - dt * 0.01, 0, 1);
  messageT -= dt;

  // 玩家跳 → 寵物跟著跳
  if (geom?.full) {
    baseHip = baseHip == null ? geom.hip.y : baseHip + (geom.hip.y - baseHip) * 0.02;
    if ((baseHip - geom.hip.y) / T > 0.15 && pet.hop <= 0) {
      pet.hop = 0.6;
      pet.spin = 0.6;
      pet.mood = clamp(pet.mood + 0.05, 0, 1);
      sfx.hop();
    }
  }

  const [lh, rh] = hands();
  const petR = 50 * S * stage().size;

  // 摸摸：左手在寵物附近移動
  if (lh && dist(lh, pet) < petR * 1.8) {
    const moved = lastHand ? dist(lh, lastHand) : 0;
    if (moved > 2 * S) {
      pettingT += dt;
      if (pettingT > 0.4) {
        pettingT = 0;
        pet.mood = clamp(pet.mood + 0.06, 0, 1);
        save.pets += 1;
        hearts.push({ x: pet.x + rand(-20, 20) * S, y: pet.y - petR, t: 1 });
        sfx.purr();
      }
    }
  }
  lastHand = lh ? { x: lh.x, y: lh.y } : null;

  // 食物
  spawnT -= dt;
  if (spawnT <= 0 && foods.length < 3) {
    spawnT = rand(3, 6);
    foods.push({ icon: pick(FOODS), x: rand(0.15, 0.85) * W, y: -40 * S, vy: rand(60, 100) * S, rot: 0 });
  }
  [lh, rh].forEach((hand, i) => {
    if (!hand) return;
    if (!held[i]) {
      const f = foods.find((f) => !f.held && dist(f, hand) < 60 * S);
      if (f) {
        f.held = true;
        held[i] = f;
        sfx.grab();
      }
    } else {
      held[i].x = hand.x;
      held[i].y = hand.y - 20 * S;
      if (dist(held[i], pet) < petR * 1.6) {
        held[i].eaten = true;
        held[i] = null;
        const before = stage();
        save.fed += 1;
        pet.mood = clamp(pet.mood + 0.2, 0, 1);
        pet.hop = 0.4;
        shell.fx.burst(pet.x, pet.y, "#ffd447", 14, 200);
        sfx.eat();
        if (stage() !== before) {
          say(`長大了！變成${stage().name}！`);
          shell.fx.burst(pet.x, pet.y, "#ff7bd5", 40, 400);
          sfx.grow();
        } else say(pick(["好好吃！", "還要還要！", "嗯～滿足", "謝謝你！"]));
        writeSave();
      }
    }
  });
  for (const f of foods) {
    if (f.held) continue;
    f.y += f.vy * dt;
    f.rot += dt;
  }
  foods = foods.filter((f) => !f.eaten && f.y < H + 60 * S);
  for (const h of hearts) {
    h.t -= dt;
    h.y -= 50 * S * dt;
  }
  hearts = hearts.filter((h) => h.t > 0);
}

function drawPet() {
  const S = shell.S;
  const st = stage();
  const r = 50 * S * st.size;
  const hopY = pet.hop > 0 ? -Math.sin((pet.hop / 0.6) * Math.PI) * 60 * S : 0;
  ctx.save();
  ctx.translate(pet.x, pet.y + hopY);
  ctx.rotate(pet.spin > 0 ? (1 - pet.spin / 0.6) * Math.PI * 2 : Math.sin(performance.now() / 600) * 0.05);
  const squish = 1 + Math.sin(performance.now() / 300) * 0.04;
  // 身體
  ctx.fillStyle = st.color;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 16 * S;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * squish, r / squish * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // 耳朵
  ctx.beginPath();
  ctx.ellipse(-r * 0.55, -r * 0.7, r * 0.18, r * 0.3, -0.4, 0, Math.PI * 2);
  ctx.ellipse(r * 0.55, -r * 0.7, r * 0.18, r * 0.3, 0.4, 0, Math.PI * 2);
  ctx.fill();
  // 臉
  ctx.fillStyle = "#333";
  const happy = pet.mood > 0.5;
  if (pet.blink > 0 || pet.hop > 0) {
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 3 * S;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.32, -r * 0.05, r * 0.1, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
  } else {
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.32, -r * 0.08, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(255,120,150,0.5)";
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(sx * r * 0.55, r * 0.12, r * 0.12, r * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 3 * S;
  ctx.beginPath();
  if (happy) ctx.arc(0, r * 0.08, r * 0.14, 0.2, Math.PI - 0.2);
  else ctx.arc(0, r * 0.3, r * 0.12, Math.PI + 0.3, -0.3);
  ctx.stroke();
  if (st.crown) shell.text("👑", 0, -r * 1.05, { size: (r / S) * 0.6 });
  ctx.restore();

  if (messageT > 0) {
    ctx.font = `${18 * S}px system-ui, sans-serif`;
    const bw = Math.max(ctx.measureText(message).width + 40 * S, 140 * S);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(pet.x - bw / 2, pet.y - r - 70 * S, bw, 36 * S);
    shell.text(message, pet.x, pet.y - r - 52 * S, { size: 18, color: "#333" });
  }
}

function drawHud() {
  const { S } = shell;
  const st = stage();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(10, 10, 250 * S, 100 * S);
  shell.text(st.name, 22, 32 * S, { align: "left", bold: true });
  shell.text(`心情`, 22, 62 * S, { align: "left", size: 16 });
  shell.bar(70 * S, 55 * S, 170 * S, 12 * S, pet.mood, "#ff7bd5");
  const next = (Math.floor(save.fed / 6) + 1) * 6;
  shell.text(
    stage() === STAGES[STAGES.length - 1] ? `已餵 ${save.fed} 次・最終型態！` : `已餵 ${save.fed} 次・再 ${next - save.fed} 次長大`,
    22,
    92 * S,
    { align: "left", size: 16 },
  );
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
  if (state === "playing") {
    for (const f of foods) shell.text(f.icon, f.x, f.y, { size: 46 });
    drawPet();
    for (const h of hearts) {
      ctx.globalAlpha = h.t;
      shell.text("💗", h.x, h.y, { size: 26 });
    }
    ctx.globalAlpha = 1;
    shell.fx.draw();
    drawHud();
    if (!DEBUG && !geom?.upper) shell.text("小麻糬找不到你的肩膀，請讓上半身入鏡", shell.W / 2, shell.H - 40 * shell.S, { color: "#ffb3b3" });
  }
});

shell.init();
