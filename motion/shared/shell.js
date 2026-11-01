// 所有鏡頭遊戲共用的外殼：畫布、選單、鏡頭、MediaPipe 模型、特效、最高分
import {
  FilesetResolver,
  HandLandmarker,
  GestureRecognizer,
  PoseLandmarker,
  FaceLandmarker,
  ImageSegmenter,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import * as sound from "./sound.js";

export { sound };

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_BASE = "https://storage.googleapis.com/mediapipe-models";

const MODELS = {
  hand: {
    task: HandLandmarker,
    url: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    opts: { numHands: 2 },
    run: "detectForVideo",
  },
  gesture: {
    task: GestureRecognizer,
    url: `${MODEL_BASE}/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`,
    opts: { numHands: 1 },
    run: "recognizeForVideo",
  },
  pose: {
    task: PoseLandmarker,
    url: `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    opts: { numPoses: 1 },
    run: "detectForVideo",
  },
  face: {
    task: FaceLandmarker,
    url: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    opts: { numFaces: 1, outputFaceBlendshapes: true },
    run: "detectForVideo",
  },
  segment: {
    task: ImageSegmenter,
    url: `${MODEL_BASE}/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite`,
    opts: { outputConfidenceMasks: true, outputCategoryMask: false },
    run: "segmentForVideo",
  },
};

// 網址加上 ?debug 可以不用鏡頭測試（各遊戲自行決定除錯按鍵）
export const DEBUG = new URLSearchParams(location.search).has("debug");

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (prev, next, a = 0.5) => prev + (next - prev) * a;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 三點夾角（度），b 為頂點
export function angle(a, b, c) {
  const v1 = Math.atan2(a.y - b.y, a.x - b.x);
  const v2 = Math.atan2(c.y - b.y, c.x - b.x);
  const d = Math.abs(((v1 - v2) * 180) / Math.PI);
  return d > 180 ? 360 - d : d;
}

function el(tag, attrs = {}, parent = document.body) {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  parent.appendChild(e);
  return e;
}

/**
 * 建立遊戲外殼
 * @param {object} o
 * @param {string} o.title 遊戲名稱
 * @param {string[]} o.help 說明條列（可含 HTML）
 * @param {string} [o.hint] 說明下方的小字
 * @param {string|null} [o.model] hand | gesture | pose | face | segment | null（只要鏡頭）
 * @param {object} [o.modelOptions] 覆寫模型參數
 * @param {string} [o.readyText] 載入完成後的提示
 * @param {number} [o.dim] 鏡頭畫面變暗的程度 0~1
 */
export function createShell(o) {
  document.title = o.title;

  const canvas = el("canvas", { className: "game" });
  const ctx = canvas.getContext("2d");
  const video = el("video", { className: "cam", autoplay: true, playsInline: true, muted: true });
  el("a", { className: "home", href: "../", textContent: "⬅ 首頁" });
  const muteBtn = el("button", { className: "mute", title: "靜音（M）" });

  const overlay = el("div", { className: "overlay" });
  const titleEl = el("h1", { textContent: o.title }, overlay);
  const statusEl = el("p", { className: "status", textContent: "載入中…" }, overlay);
  const resultEl = el("div", { className: "result" }, overlay);
  const helpEl = el("ul", { className: "help", innerHTML: o.help.map((h) => `<li>${h}</li>`).join("") }, overlay);
  el("p", { className: "hint", textContent: `${o.hint ? o.hint + "　·　" : ""}M = 靜音　·　先點一下畫面才會有聲音` }, overlay);
  const startBtn = el("button", { className: "start", textContent: "開始", disabled: true }, overlay);

  const shell = {
    canvas,
    ctx,
    video,
    W: 0,
    H: 0,
    S: 1,
    ready: false, // 鏡頭與模型都好了
    menuOpen: true,
    result: null, // 最近一次的偵測結果
    fresh: false, // 這一幀是否有新的偵測結果
    dim: o.dim ?? 0.45,
  };

  // ---------- 畫布 ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    shell.W = window.innerWidth;
    shell.H = window.innerHeight;
    canvas.width = shell.W * dpr;
    canvas.height = shell.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    shell.S = Math.min(shell.W, shell.H) / 700;
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- 音效 ----------
  const updateMute = () => (muteBtn.textContent = sound.isMuted() ? "🔇" : "🔊");
  muteBtn.addEventListener("click", () => {
    sound.toggleMute();
    updateMute();
  });
  window.addEventListener("keydown", (e) => {
    sound.unlockAudio();
    if (e.code === "KeyM" && !e.repeat) {
      sound.toggleMute();
      updateMute();
    }
  });
  window.addEventListener("pointerdown", () => sound.unlockAudio());
  updateMute();

  // ---------- 選單 ----------
  let menuMsg = "";
  let startCb = () => {};
  let hold = 0;

  shell.setStatus = (msg) => {
    menuMsg = msg;
    statusEl.textContent = msg;
  };
  shell.onStart = (cb) => (startCb = cb);
  startBtn.addEventListener("click", () => startCb());

  shell.showMenu = ({ title, status, result = "", startLabel = "再玩一次" } = {}) => {
    if (title) titleEl.textContent = title;
    if (status) shell.setStatus(status);
    resultEl.innerHTML = result;
    resultEl.classList.toggle("show", !!result);
    helpEl.style.display = result ? "none" : "";
    startBtn.textContent = startLabel;
    overlay.classList.remove("hidden");
    shell.menuOpen = true;
    hold = 0;
  };
  shell.hideMenu = () => {
    overlay.classList.add("hidden");
    shell.menuOpen = false;
  };

  // 免手操作：條件成立撐 1 秒就開始
  shell.updateHoldStart = (active, dt, label) => {
    if (!shell.menuOpen || startBtn.disabled) return;
    const was = hold > 0;
    hold = active ? hold + dt : 0;
    if (hold > 0) statusEl.textContent = `${label}… ${Math.max(0, 1 - hold).toFixed(1)}s`;
    else if (was) statusEl.textContent = menuMsg;
    if (hold >= 1) {
      hold = 0;
      statusEl.textContent = menuMsg;
      startCb();
    }
  };

  // ---------- 鏡頭座標 ----------
  // 鏡頭影像以 cover 方式鋪滿畫面
  shell.videoRect = () => {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const sc = Math.max(shell.W / vw, shell.H / vh);
    return { x: (shell.W - vw * sc) / 2, y: (shell.H - vh * sc) / 2, w: vw * sc, h: vh * sc };
  };
  // MediaPipe 的 0~1 座標 → 螢幕座標（鏡像）
  shell.toScreen = (p) => {
    const r = shell.videoRect();
    return { x: r.x + (1 - p.x) * r.w, y: r.y + p.y * r.h };
  };
  shell.drawVideo = (dim = shell.dim) => {
    const { W, H } = shell;
    if (video.readyState >= 2) {
      const r = shell.videoRect();
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, W - r.x - r.w, r.y, r.w, r.h);
      ctx.restore();
    } else {
      ctx.fillStyle = "#0d1226";
      ctx.fillRect(0, 0, W, H);
    }
    if (dim > 0) {
      ctx.fillStyle = `rgba(10, 14, 32, ${dim})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  // ---------- 偵測 ----------
  let model = null;
  let lastVideoTime = -1;
  shell.detect = () => {
    shell.fresh = false;
    if (!model || video.readyState < 2 || video.currentTime === lastVideoTime) return shell.result;
    lastVideoTime = video.currentTime;
    const spec = MODELS[o.model];
    shell.result = model[spec.run](video, performance.now());
    shell.fresh = true;
    return shell.result;
  };

  // ---------- 特效 ----------
  let parts = [];
  let texts = [];
  shell.fx = {
    burst(x, y, color, n = 16, speed = 300) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = speed * (0.3 + Math.random() * 0.7);
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.7, color });
      }
    },
    text(text, x, y, color = "#fff", size = 26) {
      texts.push({ text, x, y, color, size, life: 1 });
    },
    clear() {
      parts = [];
      texts = [];
    },
    update(dt) {
      for (const p of parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 500 * dt;
        p.life -= dt;
      }
      parts = parts.filter((p) => p.life > 0);
      for (const t of texts) {
        t.y -= 60 * dt;
        t.life -= dt;
      }
      texts = texts.filter((t) => t.life > 0);
    },
    draw() {
      const S = shell.S;
      for (const p of parts) {
        ctx.globalAlpha = clamp(p.life / 0.7, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 3 * S, p.y - 3 * S, 6 * S, 6 * S);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const t of texts) {
        ctx.globalAlpha = clamp(t.life, 0, 1);
        ctx.fillStyle = t.color;
        ctx.font = `bold ${t.size * S}px system-ui, sans-serif`;
        ctx.fillText(t.text, t.x, t.y);
      }
      ctx.globalAlpha = 1;
    },
  };

  // ---------- 繪圖小工具 ----------
  shell.text = (text, x, y, { size = 22, color = "#fff", align = "center", bold = false, base = "middle" } = {}) => {
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillStyle = color;
    ctx.font = `${bold ? "bold " : ""}${size * shell.S}px system-ui, sans-serif`;
    ctx.fillText(text, x, y);
  };
  shell.bar = (x, y, w, h, ratio, color = "#5be37d", back = "rgba(255,255,255,0.2)") => {
    ctx.fillStyle = back;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * clamp(ratio, 0, 1), h);
  };
  shell.banner = (title, sub, progress = null) => {
    const { W, H, S } = shell;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, H / 2 - 80 * S, W, 160 * S);
    shell.text(title, W / 2, H / 2 - 22 * S, { size: 38, bold: true });
    shell.text(sub, W / 2, H / 2 + 22 * S, { size: 20 });
    if (progress != null) shell.bar(W / 2 - 130 * S, H / 2 + 50 * S, 260 * S, 10 * S, progress);
  };

  // ---------- 最高分 ----------
  // 用遊戲資料夾名稱當鍵，首頁也用同樣的規則讀取
  const folder = location.pathname.replace(/index\.html$/, "").split("/").filter(Boolean).pop() || "root";
  const bestKey = `best-${folder}`;
  shell.best = () => {
    try { return Number(localStorage.getItem(bestKey)) || 0; } catch { return 0; }
  };
  // lowerIsBetter：例如拼圖的完成時間
  shell.saveBest = (v, lowerIsBetter = false) => {
    const old = shell.best();
    const better = old === 0 || (lowerIsBetter ? v < old : v > old);
    if (better) {
      try { localStorage.setItem(bestKey, String(v)); } catch { /* 忽略 */ }
    }
    return better ? v : old;
  };

  // ---------- 主迴圈 ----------
  shell.loop = (fn) => {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      fn(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // ---------- 初始化：鏡頭 + 模型 ----------
  shell.init = async () => {
    const readyText = o.readyText || "準備好了！按「開始」";
    const markReady = () => {
      shell.ready = true;
      startBtn.disabled = false;
      shell.setStatus(readyText);
    };
    if (DEBUG) markReady();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      console.warn("無法開啟鏡頭", err);
      if (!DEBUG) shell.setStatus("無法開啟鏡頭，這個遊戲需要鏡頭才能玩");
      return;
    }

    if (o.model) {
      if (!DEBUG) shell.setStatus("載入 AI 模型中…");
      try {
        const spec = MODELS[o.model];
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: spec.url, delegate },
          runningMode: "VIDEO",
          ...spec.opts,
          ...o.modelOptions,
        });
        try {
          model = await spec.task.createFromOptions(fileset, opts("GPU"));
        } catch {
          model = await spec.task.createFromOptions(fileset, opts("CPU"));
        }
      } catch (err) {
        console.error("模型載入失敗", err);
        if (!DEBUG) shell.setStatus("AI 模型載入失敗，請檢查網路後重新整理");
        return;
      }
    }
    if (!DEBUG) markReady();
  };

  return shell;
}

// ---------- 手部工具 ----------

// 手部 21 點編號
export const HAND = { wrist: 0, thumbTip: 4, indexMcp: 5, indexTip: 8, middleMcp: 9, middleTip: 12, ringTip: 16, pinkyTip: 20 };

// 手掌大小（手腕到中指根部），用來把距離正規化
export const handSize = (h) => dist(h[HAND.wrist], h[HAND.middleMcp]);

// 手指是否伸直：指尖比指節離手腕遠很多
export function fingerUp(h, tip) {
  return dist(h[tip], h[HAND.wrist]) > dist(h[tip - 2], h[HAND.wrist]) * 1.15;
}

export const isOpenPalm = (h) =>
  [HAND.indexTip, HAND.middleTip, HAND.ringTip, HAND.pinkyTip].every((t) => fingerUp(h, t));
