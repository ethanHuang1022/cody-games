// 所有音效都用 Web Audio 即時合成，不需要音檔

const MASTER_VOL = 0.8;
const MUTE_KEY = "face-flight-muted";

let ac = null;
let master = null;
let engine = null; // 推進器噪音（持續播放，用音量控制）
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* 忽略 */ }

// 瀏覽器規定要有使用者操作（點擊、按鍵）後才能出聲
export function unlockAudio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor();
    comp.connect(ac.destination);
    master = ac.createGain();
    master.gain.value = muted ? 0 : MASTER_VOL;
    master.connect(comp);
    engine = createEngine();
  }
  if (ac.state === "suspended") ac.resume();
}

export const isUnlocked = () => !!ac && ac.state === "running";
export const isMuted = () => muted;

export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* 忽略 */ }
  if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ac.currentTime, 0.02);
  return muted;
}

function noiseBuffer() {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function envelope(g, t, vol, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

// 單音：freq 滑到 to；at 是距離現在幾秒後播放
export function tone(freq, { to = freq, type = "sine", dur = 0.15, vol = 0.3, at = 0 } = {}) {
  if (!isUnlocked()) return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  envelope(g, t, vol, dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// 濾波噪音：爆炸、電流聲
export function noise({ dur = 0.3, vol = 0.3, freq = 1000, to = freq, type = "lowpass", at = 0 } = {}) {
  if (!isUnlocked()) return;
  const t = ac.currentTime + at;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer();
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (to !== freq) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ac.createGain();
  envelope(g, t, vol, dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

export const arpeggio = (notes, gap, opts) => notes.forEach((f, i) => tone(f, { ...opts, at: i * gap }));

export const sfx = {
  star() {
    tone(880, { type: "triangle", dur: 0.12, vol: 0.25 });
    tone(1320, { type: "triangle", dur: 0.25, vol: 0.25, at: 0.07 });
  },
  hit() {
    noise({ dur: 0.4, vol: 0.5, freq: 900, to: 80 });
    tone(160, { to: 45, type: "square", dur: 0.3, vol: 0.2 });
  },
  zap() {
    tone(1200, { to: 250, type: "sawtooth", dur: 0.18, vol: 0.12 });
    noise({ dur: 0.15, vol: 0.2, freq: 3000, type: "highpass" });
  },
  shieldOn() {
    tone(400, { to: 1000, dur: 0.25, vol: 0.15 });
  },
  start() {
    arpeggio([523, 659, 784, 1047], 0.08, { type: "triangle", dur: 0.18, vol: 0.22 });
  },
  gameOver() {
    arpeggio([523, 415, 330, 262], 0.18, { type: "triangle", dur: 0.3, vol: 0.25 });
  },
  calibBeep() {
    tone(660, { dur: 0.08, vol: 0.15 });
  },
  calibOk() {
    tone(784, { type: "triangle", dur: 0.1, vol: 0.2 });
    tone(1047, { type: "triangle", dur: 0.18, vol: 0.2, at: 0.08 });
  },
  calibRetry() {
    tone(220, { type: "square", dur: 0.12, vol: 0.12 });
    tone(196, { type: "square", dur: 0.2, vol: 0.12, at: 0.12 });
  },
  calibDone() {
    arpeggio([523, 659, 784, 1047, 1319], 0.09, { type: "triangle", dur: 0.25, vol: 0.22 });
  },
};

// ---------- 推進器 ----------

function createEngine() {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer();
  src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 300;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(master);
  src.start();
  return { filter, gain };
}

// v: 0~1，嘴張越大聲音越大越亮
export function setThrust(v) {
  if (!isUnlocked()) return;
  const t = ac.currentTime;
  engine.gain.gain.setTargetAtTime(v * 0.12, t, 0.05);
  engine.filter.frequency.setTargetAtTime(300 + v * 1500, t, 0.05);
}

// ---------- 背景音樂：簡單的五聲音階琶音 ----------

const BASS = [110, 110, 87.3, 98]; // A2 A2 F2 G2
const ARP = [0, 2, 4, 5, 4, 2, 3, 1]; // 每小節 8 個八分音符
const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];

let musicTimer = null;
let musicStep = 0;
let nextNote = 0;
let tempo = 120;

export function setMusicSpeed(mult) {
  tempo = 120 * mult;
}

export function startMusic() {
  if (musicTimer || !isUnlocked()) return;
  musicStep = 0;
  nextNote = ac.currentTime + 0.05;
  musicTimer = setInterval(scheduleMusic, 25);
}

export function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = null;
}

// 預先排好接下來 0.1 秒內的音符，節奏才不會被畫面卡頓影響
function scheduleMusic() {
  const eighth = 60 / tempo / 2;
  while (nextNote < ac.currentTime + 0.1) {
    const at = Math.max(0, nextNote - ac.currentTime);
    const root = BASS[Math.floor(musicStep / 8) % BASS.length];
    const i = musicStep % 8;
    if (i % 4 === 0) tone(root, { type: "triangle", dur: eighth * 3.5, vol: 0.18, at });
    tone(root * 4 * SCALE[ARP[i]], { type: "triangle", dur: eighth * 0.9, vol: 0.06, at });
    nextNote += eighth;
    musicStep += 1;
  }
}
