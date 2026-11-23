/* MaqamLab v2 — pitch.js
   Detektor pitch vokal berbasis YIN (de Cheveigné & Kawahara, 2002).
   Pakai: <script src="pitch.js"></script>  →  window.MaqamPitch
   - detect(buf, sampleRate)            : 1 frame → {freq, clarity} atau null
   - openMic(audioCtx)                  : {read(), stop()} untuk deteksi live
   - analyzeAudioBuffer(audioBuffer)    : seluruh file → {frames, hopSec}
*/
(function (g) {
  // Matikan pemrosesan browser: ia merusak nada tahan & humming.
  const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

  // Turunkan sample rate (rata-rata blok) agar YIN cepat; fundamental vokal <800 Hz tetap aman.
  function decimate(buf, f) {
    const n = Math.floor(buf.length / f), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < f; j++) s += buf[i * f + j];
      out[i] = s / f;
    }
    return out;
  }

  function yin(buf, sr, o = {}) {
    const thr = o.threshold ?? 0.15, minHz = o.minHz ?? 80, maxHz = o.maxHz ?? 800, minRms = o.minRms ?? 0.01;
    const N = buf.length;
    let e = 0;
    for (let i = 0; i < N; i++) e += buf[i] * buf[i];
    if (Math.sqrt(e / N) < minRms) return null; // hening

    const maxTau = Math.min(Math.floor(sr / minHz), N >> 1);
    const minTau = Math.max(2, Math.floor(sr / maxHz));
    const W = N - maxTau - 1;
    const cm = new Float32Array(maxTau + 2); // cumulative mean normalized difference
    cm[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
      run += s;
      cm[tau] = run > 0 ? (s * tau) / run : 1;
    }
    // Lembah pertama di bawah ambang (mencegah octave error ke kelipatan periode)
    let tau = -1;
    for (let t = minTau; t < maxTau; t++) {
      if (cm[t] < thr) {
        while (t + 1 < maxTau && cm[t + 1] < cm[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null; // tidak bernada (noise/napas) → bukan frame bersuara
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
    const den = a - 2 * b + c;
    const shift = den ? (0.5 * (a - c)) / den : 0; // interpolasi parabola → presisi sub-sampel
    return { freq: sr / (tau + shift), clarity: 1 - b };
  }

  function detect(buf, sr, o) {
    const f = sr >= 32000 ? 4 : 2;
    return yin(decimate(buf, f), sr / f, o);
  }

  async function openMic(audioCtx) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0;
    src.connect(an); // tidak disambungkan ke speaker → tanpa feedback
    const buf = new Float32Array(an.fftSize); // dibuat sekali, bukan per frame
    return {
      stream,
      read() { an.getFloatTimeDomainData(buf); return detect(buf, audioCtx.sampleRate); },
      stop() { stream.getTracks().forEach(t => t.stop()); try { src.disconnect(); } catch (e) {} }
    };
  }

  // Pindai seluruh file (default maks 180 dtk), bukan hanya 45 irisan di 12 detik pertama.
  async function analyzeAudioBuffer(ab, o = {}) {
    const sr = ab.sampleRate, win = 4096, hop = 2048;
    const len = Math.min(ab.length, Math.floor((o.maxSec ?? 180) * sr));
    const mono = new Float32Array(len), ch = ab.numberOfChannels;
    for (let c = 0; c < ch; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    const frames = [];
    for (let i = 0, k = 0; i + win <= len; i += hop, k++) {
      const r = detect(mono.subarray(i, i + win), sr, o);
      frames.push(r && r.clarity >= 0.8 ? r.freq : null);
      if (k % 150 === 0) {
        if (o.onProgress) o.onProgress(i / len);
        await new Promise(res => setTimeout(res)); // beri napas ke UI
      }
    }
    return { frames, hopSec: hop / sr };
  }

  g.MaqamPitch = { MIC_CONSTRAINTS, yin, detect, openMic, analyzeAudioBuffer };
})(window);
