/* MaqamLab v2 — classifier.js
   Pakai: MaqamClassifier.classify(frames, hopSec, MAQAM_DATA)
   frames = array frekuensi per langkah waktu (null = tidak bersuara), dari pitch.js.
   Alur: frame → cents → segmentasi nada → kandidat tonik (nada akhir, durasi, nada terendah)
         → skor kecocokan tiap nagham pada tiap kandidat tonik → peringkat + keyakinan.
*/
(function (g) {
  // Pasangan dengan himpunan nada identik (beda hanya tonik). Histogram saja tidak bisa membedakannya.
  const TWINS = [['rast', 'sika'], ['jiharka', 'kurdi']];
  const NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#']; // 0 cents = A440

  const toCents = f => 1200 * Math.log2(f / 440);
  const mod = (x, m) => ((x % m) + m) % m;
  const circ = (a, b) => { const d = Math.abs(a - b) % 1200; return Math.min(d, 1200 - d); };
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  // Ke cents + koreksi lompatan oktaf + median filter (buang glitch 1 frame)
  function smooth(frames, k = 5) {
    const raw = new Array(frames.length).fill(null);
    let prev = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] == null) continue;
      let c = toCents(frames[i]);
      if (prev !== null) { while (c - prev > 900) c -= 1200; while (prev - c > 900) c += 1200; }
      raw[i] = prev = c;
    }
    const half = k >> 1, out = raw.slice();
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] == null) continue;
      const w = [];
      for (let j = i - half; j <= i + half; j++) if (raw[j] != null) w.push(raw[j]);
      out[i] = median(w);
    }
    return out;
  }

  // Gabungkan frame berdekatan (±55 cent) menjadi nada berdurasi
  function segment(c, hop, tol = 55, minSec = 0.18, gap = 3) {
    const notes = []; let cur = null, miss = 0;
    const close = () => {
      if (cur && cur.n * hop >= minSec) notes.push({ cents: cur.mean, dur: cur.n * hop });
      cur = null;
    };
    for (const v of c) {
      if (v == null) { if (cur && ++miss > gap) close(); continue; }
      miss = 0;
      if (cur && Math.abs(v - cur.mean) <= tol) { cur.sum += v; cur.n++; cur.mean = cur.sum / cur.n; }
      else { close(); cur = { sum: v, n: 1, mean: v }; }
    }
    close();
    return notes;
  }

  // Kandidat tonik = klaster kelas-nada, dinilai dari durasi, nada penutup, dan nada terendah
  function tonicCandidates(notes) {
    const total = notes.reduce((a, n) => a + n.dur, 0);
    const lastTwo = notes.slice(-2);
    const fin = lastTwo.reduce((a, b) => (b.dur >= a.dur ? b : a));
    const durs = notes.map(n => n.dur), medDur = median(durs);
    const low = notes.filter(n => n.dur >= medDur).reduce((a, b) => (b.cents < a.cents ? b : a));
    const cl = [];
    for (const n of notes) {
      const pc = mod(n.cents, 1200);
      let c = cl.find(x => circ(x.pc, pc) <= 40);
      if (!c) { c = { pc, dur: 0, fin: false, low: false }; cl.push(c); }
      let d = pc - c.pc; if (d > 600) d -= 1200; if (d < -600) d += 1200;
      c.pc = mod(c.pc + (d * n.dur) / (c.dur + n.dur), 1200);
      c.dur += n.dur;
      if (n === fin) c.fin = true;
      if (n === low) c.low = true;
    }
    cl.forEach(c => { c.score = 0.45 * (c.dur / total) + (c.fin ? 0.4 : 0) + (c.low ? 0.15 : 0); });
    return cl.sort((a, b) => b.score - a.score);
  }

  // Seberapa cocok nada-nada dengan tangga nada m jika tonik = T (cents)
  function fit(notes, m, T) {
    const degs = m.intervals.slice(0, -1); // tanpa oktaf 1200
    const use = new Array(degs.length).fill(0);
    let good = 0, tot = 0;
    for (const n of notes) {
      const r = mod(n.cents - T, 1200);
      let best = Infinity, bi = 0;
      degs.forEach((iv, i) => { const d = circ(r, iv); if (d < best) { best = d; bi = i; } });
      good += n.dur * Math.exp(-(best * best) / (2 * 30 * 30)); // toleransi ±30 cents
      tot += n.dur;
      if (best <= 45) use[bi] += n.dur;
    }
    const cov = use.filter(u => u / tot >= 0.04).length / degs.length; // derajat yang benar-benar dipakai
    return { fit: good / tot, cov };
  }

  function tonicName(T) {
    const s = Math.round(T / 100), off = Math.round(T - s * 100);
    return NAMES[mod(s, 12)] + (Math.abs(off) >= 15 ? ` (${off > 0 ? '+' : ''}${off}c)` : '');
  }

  function classify(frames, hopSec, DATA) {
    const notes = segment(smooth(frames), hopSec);
    const voiced = notes.reduce((a, n) => a + n.dur, 0);
    if (voiced < 3 || notes.length < 6)
      return { error: 'Suara terlalu singkat atau kurang jelas (butuh ≥3 detik bersuara dan ≥6 nada). Dekatkan mikrofon dan ulangi.' };
    const cands = tonicCandidates(notes);
    if (cands.length < 3)
      return { error: 'Hanya ' + cands.length + ' nada berbeda yang terbaca. Senandungkan minimal satu frasa melodi.' };

    const ranked = Object.values(DATA).map(m => {
      let best = null;
      for (const c of cands.slice(0, 4)) {
        const f = fit(notes, m, c.pc);
        const s = 0.7 * f.fit + 0.15 * f.cov + 0.15 * c.score;
        if (!best || s > best.score) best = { score: s, fit: Math.round(f.fit * 100), T: c.pc };
      }
      return { id: m.id, name: m.name, arabic: m.arabic, ...best };
    }).sort((a, b) => b.score - a.score);

    // Keyakinan = softmax skor (bukan "persen kecocokan" mentah)
    const z = ranked.map(r => Math.exp(r.score / 0.06)), zs = z.reduce((a, b) => a + b, 0);
    ranked.forEach((r, i) => { r.prob = z[i] / zs; });

    const [a, b] = ranked;
    const isTwin = TWINS.some(p => p.includes(a.id) && p.includes(b.id));
    return {
      ranked, best: a, confidence: a.prob,
      tonicName: tonicName(a.T),
      twin: isTwin && a.score - b.score < 0.08
        ? `${a.name} dan ${b.name} memakai himpunan nada yang sama; yang membedakan hanya nada dasar. Pastikan Anda mengakhiri lantunan di qoror.`
        : null,
      voicedSec: voiced, noteCount: notes.length
    };
  }

  g.MaqamClassifier = { classify, smooth, segment, tonicCandidates };
})(window);
