// 共用：麥克風、音量、音高偵測、音符工具
const Mic = {
  ctx: null,
  analyser: null,
  buf: null,

  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('此瀏覽器不支援麥克風，請用 Chrome / Edge，並透過 localhost 或 https 開啟。');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  },

  read() {
    this.analyser.getFloatTimeDomainData(this.buf);
    return this.buf;
  },

  rms() {
    const b = this.read();
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  },

  db() {
    return 20 * Math.log10(Math.max(this.rms(), 1e-6));
  },

  // 自相關法偵測基頻，回傳 Hz；無法判斷時回傳 -1
  pitch() {
    const buf = this.read();
    const sr = this.ctx.sampleRate;
    const n = buf.length;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.01) return -1;

    const minLag = Math.floor(sr / 1100);
    const maxLag = Math.min(Math.floor(sr / 70), n - 1);
    const c = new Float32Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let j = 0; j < n - lag; j++) s += buf[j] * buf[j + lag];
      c[lag] = s;
    }
    let d = minLag;
    while (d < maxLag && c[d] > c[d + 1]) d++;
    let best = -1, pos = -1;
    for (let i = d; i <= maxLag; i++) {
      if (c[i] > best) { best = c[i]; pos = i; }
    }
    if (pos <= 0 || best / c[0] < 0.5) return -1;
    // 拋物線內插提高精度
    const x1 = c[pos - 1], x2 = c[pos], x3 = c[pos + 1];
    const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
    const t = a ? pos - b / (2 * a) : pos;
    return sr / t;
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };

const Note = {
  freqToMidi: (f) => 69 + 12 * Math.log2(f / 440),
  midiToFreq: (m) => 440 * Math.pow(2, (m - 69) / 12),
  name(m) {
    const r = Math.round(m);
    return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  },
  // 'C4' -> 60
  parse(s) {
    const m = s.match(/^([A-G]#?)(\d)$/);
    return NOTE_NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
  },
  solfege(s) {
    return SOLFEGE[s.replace(/#?\d$/, '')] || s;
  },
};

// 播放一個柔和的音
function playTone(freq, dur = 0.8, when = 0) {
  const ctx = Mic.ctx;
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc2.type = 'sine';
  osc.frequency.value = freq;
  osc2.frequency.value = freq * 2;
  const g2 = ctx.createGain();
  g2.gain.value = 0.15;
  osc.connect(g);
  osc2.connect(g2).connect(g);
  g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.start(t); osc2.start(t);
  osc.stop(t + dur + 0.05); osc2.stop(t + dur + 0.05);
}

// 簡單音效
function sfx(type) {
  if (!Mic.ctx) return;
  const seq = {
    good: [[660, 0.12], [880, 0.2]],
    bad: [[300, 0.15], [200, 0.25]],
    win: [[523, 0.15], [659, 0.15], [784, 0.15], [1047, 0.35]],
  }[type];
  let t = 0;
  for (const [f, d] of seq) { playTone(f, d + 0.1, t); t += d; }
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

// 玩家頭像（各遊戲共用）
// 頭像照片載入失敗時改用 Q 版 Cody
const headImg = new Image();
const ASSET_VERSION = '20261101171856'; // 由 bump-version.sh 更新，避免瀏覽器用到快取的舊圖
headImg.onerror = () => { headImg.onerror = null; headImg.src = 'img/player-head.svg?v=' + ASSET_VERSION; };
headImg.src = 'img/head_cutout_2.png?v=' + ASSET_VERSION;

// 以 (cx, cy) 為中心畫出高度 h 的頭像；圖片還沒載入時回傳 false，讓呼叫端畫備用圖形
function drawHead(g, cx, cy, h, squashY = 1) {
  if (!headImg.complete || !headImg.naturalWidth) return false;
  const w = (h * headImg.naturalWidth) / headImg.naturalHeight;
  const hh = h * squashY;
  g.drawImage(headImg, cx - w / 2, cy + h / 2 - hh, w, hh);
  return true;
}
