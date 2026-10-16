/**
 * Tayyor test fayllarini (Word .docx, Excel .xlsx, matn .txt/.csv) savollarga aylantirish.
 *
 * Qo'llab-quvvatlanadigan belgilashlar (to'g'ri javob):
 *   - variant oldida yoki oxirida  *  +  #  ✓  belgisi:      *B) 1991-yil
 *   - Word'da to'g'ri variant qalin (bold), rangli yoki marker bilan ajratilgan
 *   - savoldan keyin "Javob: B" qatori
 *   - fayl oxirida javoblar kaliti: "Javoblar: 1-B, 2-C, 3-A ..."
 *   - Excel'da: Savol | A | B | C | D | To'g'ri javob  ustunlari
 * Topilmagan to'g'ri javoblar `correct: null` bo'lib qaytadi — admin ularni qo'lda belgilaydi.
 */
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const LATIN = 'ABCDEF';
const CYR = 'АБВГДЕ';
const MARK = '[*+#✓✔]';

function letterIndex(ch, labels) {
  if (!ch) return -1;
  const u = ch.toUpperCase();
  if (labels) {
    const i = labels.indexOf(u);
    if (i >= 0) return i;
  }
  let i = LATIN.indexOf(u);
  if (i >= 0) return i;
  i = CYR.indexOf(u);
  return i;
}

const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();

/* ---------- Word (.docx) → qatorlar (+ ajratilgan bo'laklar) ---------- */
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
async function docxLines(buf) {
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Word fayli o\'qilmadi (document.xml topilmadi)');
  const xml = await file.async('string');
  const lines = [];
  // Har bir paragraf (jadval kataklari ham paragraf ichida bo'ladi)
  for (const pm of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    const runs = [];
    for (const rm of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const pr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      const on = (tag) => new RegExp(`<w:${tag}(?:\\s+w:val="(?!0|false|none)[^"]*")?\\s*/>`).test(pr);
      const color = (pr.match(/<w:color w:val="([0-9A-Fa-f]{6})"/) || [])[1];
      const marked = on('b') || on('u') || /<w:highlight w:val="(?!none)/.test(pr) || /<w:shd [^>]*w:fill="(?!auto|FFFFFF)[0-9A-Fa-f]{6}"/.test(pr)
        || (color && !/^(000000|auto)$/i.test(color));
      let text = '';
      for (const t of r.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
        if (t[0].startsWith('<w:tab')) text += ' ';
        else if (t[0].startsWith('<w:br')) text += '\n';
        else text += decodeXml(t[1]);
      }
      if (text) runs.push({ text, marked });
    }
    // Paragraf ichidagi <w:br/> qatorlarga bo'linadi
    let cur = { text: '', spans: [] };
    const push = () => { lines.push(cur); cur = { text: '', spans: [] }; };
    for (const run of runs) {
      const parts = run.text.split('\n');
      parts.forEach((part, k) => {
        if (k > 0) push();
        if (part) { cur.spans.push({ from: cur.text.length, to: cur.text.length + part.length, marked: run.marked }); cur.text += part; }
      });
    }
    push();
  }
  return lines;
}

/* ---------- Matn qatorlaridan savollar ---------- */
const Q_RE = /^\s*(?:savol\s*)?(\d{1,3})\s*[.)\-–:]\s*(.*)$/i;
const OPT_START = new RegExp(`^\\s*(${MARK})?\\s*([A-Fa-fА-Еа-е])\\s*[).\\]]\\s*(.*)$`);
const OPT_INLINE = new RegExp(`(?:^|\\s)(${MARK})?\\s*([A-FА-Е])\\s*\\)\\s*`, 'g');
const ANSWER_LINE = /^\s*(?:to['ʻ’`]?g['ʻ’`]?ri\s+)?javob(?:i)?\s*[:\-–]\s*([A-Fa-fА-Еа-е])\b/i;
const KEY_HEAD = /^\s*(javoblar|javob\s*kaliti|kalit|to['ʻ’`]?g['ʻ’`]?ri\s+javoblar|ответы|keys?|answers?)\b\s*[:\-–]?\s*(.*)$/i;

// Qator ichida bir nechta variant bo'lsa ("A) 3  B) 4  C) 5") — bo'laklarga ajratish
function splitInlineOptions(text) {
  const hits = [...text.matchAll(OPT_INLINE)];
  // Ketma-ket harflar (A,B,C...) bo'lsagina inline variant deb hisoblaymiz
  if (hits.length < 2) return null;
  const idx = hits.map((h) => letterIndex(h[2]));
  if (idx[0] !== 0 || idx.some((v, k) => v !== k)) return null;
  return hits.map((h, k) => {
    const start = h.index + h[0].length;
    const end = k + 1 < hits.length ? hits[k + 1].index : text.length;
    return { mark: Boolean(h[1]), label: h[2].toUpperCase(), text: text.slice(start, end), start, end, headStart: h.index };
  });
}

function stripMarks(s) {
  let mark = false;
  let t = clean(s);
  const m1 = t.match(new RegExp(`^${MARK}\\s*`));
  if (m1) { mark = true; t = t.slice(m1[0].length); }
  const m2 = t.match(new RegExp(`\\s*(?:${MARK}|\\(\\s*to['ʻ’\`]?g['ʻ’\`]?ri\\s*\\))\\s*$`, 'i'));
  if (m2) { mark = true; t = t.slice(0, t.length - m2[0].length); }
  return { text: clean(t), mark };
}

function spanMarked(line, from, to) {
  if (!line.spans || !line.spans.length) return false;
  let total = 0; let marked = 0;
  for (const s of line.spans) {
    const a = Math.max(s.from, from); const b = Math.min(s.to, to);
    if (b > a) {
      const len = line.text.slice(a, b).replace(/\s/g, '').length;
      total += len; if (s.marked) marked += len;
    }
  }
  return total > 0 && marked / total > 0.6;
}

function parseLines(lines) {
  const questions = [];
  const warnings = [];
  let q = null;
  let keyMode = false;
  const key = new Map();

  const finish = () => {
    if (!q) return;
    if (q.options.length) questions.push(q);
    else if (q.q) warnings.push(`"${q.q.slice(0, 50)}…" — variantlar topilmadi, tashlab ketildi`);
    q = null;
  };
  const addOption = (raw, explicitMark, label, line, from, to) => {
    const { text, mark } = stripMarks(raw);
    if (!text) return;
    q.options.push(text);
    q.labels.push((label || LATIN[q.options.length - 1]).toUpperCase());
    q.flags.push({ mark: mark || explicitMark, styled: line ? spanMarked(line, from, to) : false });
  };

  for (const line of lines) {
    const text = clean(line.text);
    if (!text) continue;

    const kh = text.match(KEY_HEAD);
    if (kh && !OPT_START.test(text)) { finish(); keyMode = true; if (kh[2]) readKey(kh[2], key); continue; }
    if (keyMode) {
      if (readKey(text, key)) continue;
      keyMode = false;
    }

    const al = text.match(ANSWER_LINE);
    if (al && q) { q.answerLetter = al[1]; continue; }

    const qm = text.match(Q_RE);
    const om = text.match(OPT_START);
    // Variant: "A) ..." — lekin savol raqami bilan boshlangan bo'lsa, bu yangi savol
    if (om && q && !qm) {
      const inline = splitInlineOptions(text.replace(new RegExp(`^\\s*${MARK}?\\s*`), (m) => m));
      if (inline && inline.length > 1) {
        const lead = text.match(new RegExp(`^\\s*${MARK}`));
        inline.forEach((o, k) => addOption(o.text, o.mark || (k === 0 && Boolean(lead)), o.label, line, o.start, o.end));
      } else {
        const start = text.length - om[3].length;
        addOption(om[3], Boolean(om[1]), om[2], line, line.text.indexOf(om[3]) >= 0 ? line.text.indexOf(om[3]) : start, line.text.length);
      }
      continue;
    }
    if (qm) {
      finish();
      q = { num: Number(qm[1]), q: '', options: [], labels: [], flags: [] };
      let rest = qm[2];
      const inline = splitInlineOptions(rest);
      if (inline) {
        q.q = clean(rest.slice(0, inline[0].headStart));
        const offset = line.text.indexOf(rest);
        inline.forEach((o) => addOption(o.text, o.mark, o.label, line, offset + o.start, offset + o.end));
      } else q.q = clean(rest);
      continue;
    }
    // Davomi: savol matnining keyingi qatori yoki oxirgi variantning davomi
    if (q) {
      const inline = splitInlineOptions(text);
      if (inline) {
        const lead = clean(text.slice(0, inline[0].headStart));
        if (lead && !q.options.length) q.q = clean(q.q + ' ' + lead);
        const offset = line.text.indexOf(text);
        inline.forEach((o) => addOption(o.text, o.mark, o.label, line, offset + o.start, offset + o.end));
      } else if (!q.options.length) q.q = clean(q.q + ' ' + text);
      else q.options[q.options.length - 1] = clean(q.options[q.options.length - 1] + ' ' + text);
    } else if (!questions.length && /\?\s*$/.test(text)) {
      // Raqamsiz savol (birinchi savol raqamsiz yozilgan bo'lsa)
      q = { num: 0, q: text, options: [], labels: [], flags: [] };
    }
  }
  finish();

  // To'g'ri javobni aniqlash
  let viaKey = 0;
  questions.forEach((x, i) => {
    let correct = null;
    const marks = x.flags.map((f, k) => (f.mark ? k : -1)).filter((k) => k >= 0);
    const styled = x.flags.map((f, k) => (f.styled ? k : -1)).filter((k) => k >= 0);
    if (marks.length === 1) correct = marks[0];
    else if (x.answerLetter) correct = letterIndex(x.answerLetter, x.labels);
    else if (key.has(x.num || i + 1)) { correct = letterIndex(key.get(x.num || i + 1), x.labels); viaKey++; }
    else if (styled.length === 1 && styled.length < x.options.length) correct = styled[0];
    if (correct !== null && (correct < 0 || correct >= x.options.length)) correct = null;
    x.correct = correct;
  });
  if (key.size && !viaKey) warnings.push('Javoblar kaliti topildi, lekin savol raqamlariga mos kelmadi');

  return {
    questions: questions.map((x) => ({ q: x.q || `${x.num}-savol`, options: x.options.slice(0, 6), correct: x.correct !== null && x.correct < 6 ? x.correct : null })),
    warnings,
  };
}

// "1-B, 2-C 3) A  4.D" yoki "1B 2C" — kalitni o'qish. Qatorda kalit topilsa true.
function readKey(text, key) {
  const hits = [...text.matchAll(/(\d{1,3})\s*[-.)–:=]?\s*([A-Fa-fА-Еа-е])(?![A-Za-zА-Яа-яʻ'])/g)];
  if (!hits.length) return false;
  const covered = hits.reduce((n, h) => n + h[0].length, 0);
  if (covered < text.replace(/[\s,;|]/g, '').length * 0.6) return false;
  hits.forEach((h) => key.set(Number(h[1]), h[2]));
  return true;
}

/* ---------- Excel (.xlsx) ---------- */
async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel faylida varaq yo\'q');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c, col) => {
      let v = c.value;
      if (v && typeof v === 'object') v = v.richText ? v.richText.map((r) => r.text).join('') : (v.text ?? v.result ?? '');
      const fill = c.fill && c.fill.fgColor && (c.fill.fgColor.argb || c.fill.fgColor.theme !== undefined);
      cells[col - 1] = { text: clean(v), styled: Boolean((c.font && c.font.bold) || fill) };
    });
    rows.push(cells.map((c) => c || { text: '', styled: false }));
  });
  if (!rows.length) throw new Error('Excel varag\'i bo\'sh');

  // Sarlavha qatorini topish
  const head = rows[0].map((c) => c.text.toLowerCase());
  const isHead = head.some((h) => /savol|вопрос|question/.test(h));
  let qCol = 0; let ansCol = -1; let optCols = [];
  if (isHead) {
    head.forEach((h, k) => {
      if (/savol|вопрос|question/.test(h) && !/raqam|№|^#$/.test(h)) qCol = k;
      else if (/javob|ответ|answer|to.?g.?ri|kalit/.test(h)) ansCol = k;
      else if (/^[a-fа-е]$|^variant|^[a-f]\)|^вариант/.test(h)) optCols.push(k);
    });
  }
  const body = isHead ? rows.slice(1) : rows;
  if (!optCols.length) {
    // Sarlavhasiz: [№?] Savol | variantlar... | [javob harfi]
    const sample = body.find((r) => r.filter((c) => c.text).length >= 3) || body[0];
    const width = sample.length;
    if (/^\d+$/.test(sample[0]?.text || '') && width > 3) qCol = 1;
    const last = sample[width - 1]?.text || '';
    if (/^[A-Fa-fА-Еа-е1-6]$/.test(last)) ansCol = width - 1;
    for (let k = qCol + 1; k < width; k++) if (k !== ansCol) optCols.push(k);
  }

  const questions = []; const warnings = [];
  body.forEach((r, n) => {
    const qt = r[qCol]?.text;
    const opts = []; const flags = [];
    optCols.forEach((k) => {
      const raw = r[k]?.text; if (!raw) return;
      const s = stripMarks(raw); opts.push(s.text); flags.push({ mark: s.mark, styled: r[k].styled });
    });
    if (!qt && !opts.length) return;
    if (!qt || opts.length < 2) { warnings.push(`${n + (isHead ? 2 : 1)}-qator: savol yoki variantlar yetarli emas, tashlab ketildi`); return; }
    let correct = null;
    const a = ansCol >= 0 ? r[ansCol]?.text : '';
    if (a) {
      if (/^\d$/.test(a)) correct = Number(a) - 1;
      else if (/^[A-Fa-fА-Еа-е]$/.test(a)) correct = letterIndex(a);
      else { const k = opts.findIndex((o) => o.toLowerCase() === a.toLowerCase()); if (k >= 0) correct = k; }
    }
    if (correct === null) {
      const m = flags.map((f, k) => (f.mark ? k : -1)).filter((k) => k >= 0);
      const s = flags.map((f, k) => (f.styled ? k : -1)).filter((k) => k >= 0);
      if (m.length === 1) correct = m[0]; else if (s.length === 1) correct = s[0];
    }
    if (correct !== null && (correct < 0 || correct >= opts.length)) correct = null;
    questions.push({ q: qt, options: opts.slice(0, 6), correct: correct !== null && correct < 6 ? correct : null });
  });
  return { questions, warnings };
}

async function parseTestFile(buf, filename) {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  let res;
  if (ext === 'docx') res = parseLines(await docxLines(buf));
  else if (ext === 'xlsx') res = await parseXlsx(buf);
  else if (ext === 'txt' || ext === 'csv' || ext === 'md') {
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1');
    res = parseLines(text.replace(/^﻿/, '').split(/\r?\n/).map((t) => ({ text: t, spans: [] })));
  } else if (ext === 'doc') {
    throw new Error('Eski .doc formati qo\'llab-quvvatlanmaydi. Word\'da "Saqlash → .docx" qilib qayta yuklang.');
  } else throw new Error('Faqat .docx, .xlsx yoki .txt fayl yuklash mumkin');
  if (!res.questions.length) throw new Error('Faylda savollar topilmadi. Format namunasini ko\'ring.');
  return res;
}

module.exports = { parseTestFile, parseLines };
