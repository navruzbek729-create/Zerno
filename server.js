/**
 * ZERNO — Free Knowledge Hub
 * Backend: Node.js + Express. Ma'lumotlar MongoDB'da (MONGODB_URI) yoki data/db.json faylida saqlanadi.
 *
 * Ishga tushirish:
 *   npm install
 *   ADMIN_TOKEN="kuchli-parol" npm start      (Linux/Mac)
 *   set ADMIN_TOKEN=kuchli-parol && npm start  (Windows CMD)
 */
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'zerno2026'; // standart admin paroli
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

if (!process.env.ADMIN_TOKEN) {
  console.warn('\n⚠️  ADMIN_TOKEN berilmagan — standart admin paroli ishlatilmoqda: zerno2026\n');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- Ma'lumotlar bazasi ----------------
 * MONGODB_URI berilgan bo'lsa — MongoDB (masalan, MongoDB Atlas bepul klaster). Render kabi
 * diski vaqtinchalik hostinglarda shart: aks holda ma'lumotlar qayta ishga tushganda o'chadi.
 * Berilmagan bo'lsa — data/db.json fayli (VPS yoki kompyuterda).
 * Butun ilova xotiradagi `db` obyekti bilan ishlaydi; saveDb() o'zgarishlarni saqlaydi.
 */
const MONGODB_URI = process.env.MONGODB_URI || '';
const COLLS = ['subjects', 'tests', 'guides', 'participants', 'results'];
let mongo = null;            // { client, dbm, bucket }
const synced = {};           // MongoDB bilan oxirgi sinxron holat: coll -> Map(id -> json)
let syncedStats = '';

function normalizeDb(d) {
  d.subjects ||= []; d.tests ||= []; d.guides ||= [];
  d.participants ||= []; d.results ||= [];
  d.stats ||= { attempts: 0 };
  d.stats.attempts ||= 0;
  delete d.stats.students;
  return d;
}
function readSeed() {
  return fs.existsSync(SEED_FILE)
    ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
    : { subjects: [], tests: [], guides: [] };
}
function loadFileDb() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDb(readSeed()), null, 2));
  return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
}

let db = null;
async function initStorage() {
  if (!MONGODB_URI) { db = loadFileDb(); console.log('💾 Saqlash: data/db.json fayli'); return; }
  const { MongoClient, GridFSBucket } = require('mongodb');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const dbm = client.db(process.env.MONGODB_DB || 'zerno');
  mongo = { client, dbm, bucket: new GridFSBucket(dbm, { bucketName: 'pdfs' }) };
  const meta = await dbm.collection('meta').findOne({ _id: 'stats' });
  const counts = await Promise.all(COLLS.map((c) => dbm.collection(c).countDocuments()));
  if (!meta && counts.every((n) => n === 0)) {
    db = normalizeDb(readSeed());           // birinchi ishga tushish — namuna ma'lumotlar
    COLLS.forEach((c) => { synced[c] = new Map(); });
    await flushMongo();
    console.log('💾 Saqlash: MongoDB (namuna ma\'lumotlar yozildi)');
  } else {
    db = { stats: meta?.value || { attempts: 0 } };
    for (const c of COLLS) {
      const docs = await dbm.collection(c).find().toArray();
      db[c] = docs.map(({ _id, ...rest }) => rest);
      synced[c] = new Map(db[c].map((d) => [d.id, JSON.stringify(d)]));
    }
    db.results.sort((a, b) => a.date.localeCompare(b.date));
    normalizeDb(db);
    syncedStats = JSON.stringify(db.stats);
    console.log(`💾 Saqlash: MongoDB (${db.tests.length} test, ${db.participants.length} o'quvchi, ${db.results.length} natija)`);
  }
}

// Faqat o'zgargan hujjatlarni yozadi, o'chirilganlarini o'chiradi
async function flushMongo() {
  for (const c of COLLS) {
    const cur = new Map();
    const ops = [];
    for (const d of db[c]) {
      const j = JSON.stringify(d);
      cur.set(d.id, j);
      if (synced[c].get(d.id) !== j) ops.push({ replaceOne: { filter: { _id: d.id }, replacement: { _id: d.id, ...d }, upsert: true } });
    }
    for (const id of synced[c].keys()) if (!cur.has(id)) ops.push({ deleteOne: { filter: { _id: id } } });
    if (ops.length) await mongo.dbm.collection(c).bulkWrite(ops, { ordered: false });
    synced[c] = cur;
  }
  const st = JSON.stringify(db.stats);
  if (st !== syncedStats) {
    await mongo.dbm.collection('meta').replaceOne({ _id: 'stats' }, { _id: 'stats', value: db.stats }, { upsert: true });
    syncedStats = st;
  }
}

let saveTimer = null;
let flushing = Promise.resolve();
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNow, mongo ? 40 : 150);
}
function flushNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!mongo) {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE); // atomik yozish
    return Promise.resolve();
  }
  flushing = flushing.then(flushMongo).catch((e) => console.error('❌ MongoDB\'ga yozishda xato:', e.message));
  return flushing;
}
// Server to'xtatilganda (Render "uxlab qolganda") saqlanmagan o'zgarishlarni yozib qo'yish
async function shutdown(sig) {
  console.log(`${sig} — ma'lumotlar saqlanmoqda...`);
  try { if (saveTimer) await flushNow(); else await flushing; if (mongo) await mongo.client.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ---------------- Yordamchilar ---------------- */
const slug = (s) => String(s || '').toLowerCase()
  .replace(/[ʻʼ'`‘’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const COLORS = ['violet', 'amber', 'cyan', 'emerald', 'rose', 'sky', 'fuchsia', 'lime'];
const ICONS = ['calc', 'landmark', 'pen', 'flask', 'globe', 'atom', 'book', 'code', 'music', 'map'];

function publicStats() {
  return {
    tests: db.tests.length,
    questions: db.tests.reduce((n, t) => n + t.questions.length, 0),
    guides: db.guides.length,
    subjects: db.subjects.length,
    students: db.participants.length,
    attempts: db.stats.attempts,
  };
}
const testMeta = (t) => ({
  id: t.id, subjectId: t.subjectId, title: t.title, durationMin: t.durationMin,
  level: t.level || '', questionCount: t.questions.length,
});

function validateSubject(b, existingId) {
  const name = str(b.name, 60);
  if (!name) throw new Error('Fan nomi kiritilmagan');
  const id = existingId || slug(b.id || name) || newId('fan');
  return {
    id, name,
    description: str(b.description, 160),
    icon: ICONS.includes(b.icon) ? b.icon : 'book',
    color: COLORS.includes(b.color) ? b.color : 'violet',
    order: Number(b.order) || 99,
  };
}
function validateTest(b, existingId) {
  const title = str(b.title, 120);
  if (!title) throw new Error('Test nomi kiritilmagan');
  if (!db.subjects.some((s) => s.id === b.subjectId)) throw new Error('Fan topilmadi');
  if (!Array.isArray(b.questions) || !b.questions.length) throw new Error('Kamida bitta savol kerak');
  const questions = b.questions.slice(0, 200).map((q, i) => {
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 300)).filter(Boolean).slice(0, 6);
    const correct = Number(q.correct);
    if (!str(q.q)) throw new Error(`${i + 1}-savol matni bo'sh`);
    if (options.length < 2) throw new Error(`${i + 1}-savolda kamida 2 ta variant kerak`);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error(`${i + 1}-savolda to'g'ri javob belgilanmagan`);
    return { q: str(q.q, 1000), options, correct };
  });
  return {
    id: existingId || str(b.id, 40) || newId('test'),
    subjectId: b.subjectId, title,
    durationMin: Math.min(Math.max(Number(b.durationMin) || 10, 1), 180),
    level: str(b.level, 40), questions,
  };
}

/* ---------------- Ilova ---------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* ---- Ochiq API ---- */
app.get('/api/health', (req, res) => res.json({ ok: true, admin: Boolean(ADMIN_TOKEN) }));

app.get('/api/data', (req, res) => {
  res.json({
    subjects: [...db.subjects].sort((a, b) => a.order - b.order),
    tests: db.tests.map(testMeta),
    guides: db.guides,
    stats: publicStats(),
  });
});

// Test savollari (to'g'ri javoblarsiz)
app.get('/api/tests/:id', (req, res) => {
  const t = db.tests.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Test topilmadi' });
  res.json({ ...testMeta(t), questions: t.questions.map((q) => ({ q: q.q, options: q.options })) });
});

/* ---- Ishtirokchilar (ism + guruh bilan ro'yxatdan o'tish) ---- */
const normKey = (s) => str(s, 80).toLowerCase().replace(/[ʻʼ'`‘’]/g, "'").replace(/\s+/g, ' ');
const publicParticipant = (p) => ({ id: p.id, name: p.name, group: p.group, token: p.token });
function participantFromReq(req) {
  const token = String(req.get('x-participant') || '');
  return token ? db.participants.find((p) => p.token === token) : null;
}

// Ro'yxatdan o'tish. Xuddi shu ism + guruh qayta kiritilsa — o'sha ishtirokchi qaytariladi
// (shu tarzda boshqa qurilmadan, masalan telefondan ham o'z natijalariga kira oladi).
app.post('/api/register', (req, res) => {
  const name = str(req.body.name, 80).replace(/\s+/g, ' ');
  const group = str(req.body.group, 40).replace(/\s+/g, ' ');
  if (name.length < 3) return res.status(400).json({ error: 'Ism-familiyani to\'liq kiriting' });
  if (!group) return res.status(400).json({ error: 'Guruhni kiriting' });
  let p = db.participants.find((x) => normKey(x.name) === normKey(name) && normKey(x.group) === normKey(group));
  if (!p) {
    p = { id: newId('u'), name, group, token: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString() };
    db.participants.push(p); saveDb();
  }
  res.json(publicParticipant(p));
});

app.get('/api/me', (req, res) => {
  const p = participantFromReq(req);
  if (!p) return res.status(401).json({ error: 'Ro\'yxatdan o\'tilmagan' });
  const results = db.results.filter((r) => r.participantId === p.id)
    .map(({ answers, participantId, ...r }) => r)
    .sort((a, b) => b.date.localeCompare(a.date));
  res.json({ ...publicParticipant(p), results });
});

// Javoblarni tekshirish (serverda) va natijani saqlash
app.post('/api/tests/:id/submit', (req, res) => {
  const t = db.tests.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Test topilmadi' });
  const p = participantFromReq(req);
  if (!p) return res.status(401).json({ error: 'Avval ism va guruhingiz bilan ro\'yxatdan o\'ting' });
  const answers = Array.isArray(req.body.answers) ? req.body.answers.slice(0, t.questions.length) : [];
  const review = t.questions.map((q, i) => ({
    correct: q.correct,
    chosen: Number.isInteger(answers[i]) ? answers[i] : null,
  }));
  const score = review.filter((r) => r.chosen === r.correct).length;
  const total = t.questions.length;
  const result = {
    id: newId('r'), participantId: p.id, testId: t.id, testTitle: t.title, subjectId: t.subjectId,
    score, total, percent: Math.round((score / total) * 100),
    timeSpent: Math.max(0, Math.min(Number(req.body.timeSpent) || 0, t.durationMin * 60 + 30)),
    answers: review.map((r) => r.chosen), date: new Date().toISOString(),
  };
  db.results.push(result);
  db.stats.attempts += 1;
  saveDb();
  res.json({ score, total, review, resultId: result.id, stats: publicStats() });
});

/* ---- Sitemap (Google uchun) ---- */
app.get('/sitemap.xml', (req, res) => {
  const base = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const urls = [
    { loc: `${base}/`, priority: '1.0', changefreq: 'daily' },
    ...db.subjects.map(s => ({ loc: `${base}/#fan-${s.id}`, priority: '0.9', changefreq: 'weekly' })),
    ...db.tests.map(t => ({ loc: `${base}/#test-${t.id}`, priority: '0.8', changefreq: 'weekly' })),
    ...db.guides.map(g => ({ loc: `${base}/#qollanma-${g.id}`, priority: '0.7', changefreq: 'monthly' })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map(u => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')
  }\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

/* ---- Admin API ---- */
const loginHits = new Map();
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Admin panel o\'chirilgan (ADMIN_TOKEN yo\'q)' });
  const ip = req.ip;
  const hit = loginHits.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - hit.t > 15 * 60 * 1000) { hit.n = 0; hit.t = Date.now(); }
  if (hit.n >= 20) return res.status(429).json({ error: 'Juda ko\'p urinish. 15 daqiqadan so\'ng qayta urining.' });
  const given = Buffer.from(String(req.get('x-admin-token') || ''));
  const real = Buffer.from(ADMIN_TOKEN);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    hit.n += 1; loginHits.set(ip, hit);
    return res.status(401).json({ error: 'Parol noto\'g\'ri' });
  }
  next();
}
const admin = express.Router();
admin.use(requireAdmin);
const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

admin.get('/check', (req, res) => res.json({ ok: true }));
admin.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="zerno-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(db);
});
admin.get('/tests/:id', (req, res) => {
  const t = db.tests.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Test topilmadi' });
  res.json(t);
});

// Natijalar va ishtirokchilar
function resultRows(q) {
  const byId = new Map(db.participants.map((p) => [p.id, p]));
  const subj = new Map(db.subjects.map((s) => [s.id, s.name]));
  const group = normKey(q.group || '');
  return db.results
    .map((r) => {
      const p = byId.get(r.participantId) || { name: '(o\'chirilgan)', group: '' };
      return { id: r.id, participantId: r.participantId, name: p.name, group: p.group, testId: r.testId,
        testTitle: r.testTitle, subject: subj.get(r.subjectId) || '', score: r.score, total: r.total,
        percent: r.percent, timeSpent: r.timeSpent, date: r.date };
    })
    .filter((r) => (!group || normKey(r.group) === group) && (!q.testId || r.testId === q.testId))
    .sort((a, b) => b.date.localeCompare(a.date));
}
admin.get('/results', (req, res) => {
  const groups = [...new Set(db.participants.map((p) => p.group))].sort((a, b) => a.localeCompare(b));
  res.json({ results: resultRows(req.query), groups, participants: db.participants.length });
});
// Excel (.xlsx) — kompyuterda ham, telefonda ham ochiladi
admin.get('/results.xlsx', async (req, res) => {
  try {
    const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; }; // formula himoyasi
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ZERNO';
    const ws = wb.addWorksheet('Natijalar', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Ism-familiya', key: 'name', width: 28 },
      { header: 'Guruh', key: 'group', width: 14 },
      { header: 'Fan', key: 'subject', width: 18 },
      { header: 'Test', key: 'test', width: 28 },
      { header: "To'g'ri", key: 'score', width: 9 },
      { header: 'Jami', key: 'total', width: 8 },
      { header: 'Foiz', key: 'percent', width: 8 },
      { header: 'Vaqt (daq:son)', key: 'time', width: 14 },
      { header: 'Sana', key: 'date', width: 20 },
    ];
    for (const r of resultRows(req.query)) {
      ws.addRow({
        name: safe(r.name), group: safe(r.group), subject: safe(r.subject), test: safe(r.testTitle),
        score: r.score, total: r.total, percent: r.percent / 100,
        time: `${Math.floor(r.timeSpent / 60)}:${String(r.timeSpent % 60).padStart(2, '0')}`,
        date: new Date(r.date).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' }),
      });
    }
    ws.getColumn('percent').numFmt = '0%';
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } };
    ws.autoFilter = { from: 'A1', to: 'I1' };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="zerno-natijalar-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Excel yaratib bo\'lmadi' });
  }
});
admin.delete('/results/:id', wrap((req, res) => {
  db.results = db.results.filter((r) => r.id !== req.params.id); saveDb(); res.json({ ok: true });
}));
admin.delete('/participants/:id', wrap((req, res) => {
  db.participants = db.participants.filter((p) => p.id !== req.params.id);
  db.results = db.results.filter((r) => r.participantId !== req.params.id);
  saveDb(); res.json({ ok: true });
}));

// Fanlar
admin.post('/subjects', wrap((req, res) => {
  const s = validateSubject(req.body);
  if (db.subjects.some((x) => x.id === s.id)) s.id = newId(s.id);
  db.subjects.push(s); saveDb(); res.json(s);
}));
admin.put('/subjects/:id', wrap((req, res) => {
  const i = db.subjects.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw new Error('Fan topilmadi');
  db.subjects[i] = validateSubject(req.body, req.params.id); saveDb(); res.json(db.subjects[i]);
}));
admin.delete('/subjects/:id', wrap((req, res) => {
  if (db.tests.some((t) => t.subjectId === req.params.id)) throw new Error('Avval shu fandagi testlarni o\'chiring');
  db.subjects = db.subjects.filter((x) => x.id !== req.params.id); saveDb(); res.json({ ok: true });
}));

// Testlar
admin.post('/tests', wrap((req, res) => {
  const t = validateTest(req.body);
  if (db.tests.some((x) => x.id === t.id)) t.id = newId('test');
  db.tests.push(t); saveDb(); res.json(testMeta(t));
}));
admin.put('/tests/:id', wrap((req, res) => {
  const i = db.tests.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw new Error('Test topilmadi');
  db.tests[i] = validateTest(req.body, req.params.id); saveDb(); res.json(testMeta(db.tests[i]));
}));
admin.delete('/tests/:id', wrap((req, res) => {
  db.tests = db.tests.filter((x) => x.id !== req.params.id); saveDb(); res.json({ ok: true });
}));

// Qo'llanmalar (PDF yuklash bilan)
const pdfName = (orig) => `${Date.now()}-${slug(path.parse(orig).name) || 'fayl'}.pdf`;
const upload = multer({
  // MongoDB rejimida fayl xotiraga olinadi va GridFS'ga yoziladi (Render diski vaqtinchalik)
  storage: MONGODB_URI ? multer.memoryStorage() : multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, pdfName(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Faqat PDF fayl yuklash mumkin'), ok);
  },
});
function gridPut(buffer, filename) {
  return new Promise((resolve, reject) => {
    const up = mongo.bucket.openUploadStream(filename, { metadata: { contentType: 'application/pdf' } });
    up.once('finish', resolve).once('error', reject);
    up.end(buffer);
  });
}
function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const name = path.basename(url);
  if (mongo) {
    mongo.bucket.find({ filename: name }).toArray()
      .then((files) => Promise.all(files.map((f) => mongo.bucket.delete(f._id))))
      .catch(() => {});
  } else {
    fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {});
  }
}
function guideFromBody(b, file, prev = {}) {
  const title = str(b.title, 140);
  if (!title) throw new Error('Qo\'llanma nomi kiritilmagan');
  let url = prev.url || '';
  let size = prev.size || 0;
  if (file) { url = `/uploads/${file.filename}`; size = file.size; }
  else if (b.url !== undefined && str(b.url) !== url) {
    const u = str(b.url, 600);
    if (u && !/^https?:\/\//i.test(u) && !u.startsWith('/uploads/')) throw new Error('Havola http(s):// bilan boshlanishi kerak');
    url = u; size = 0;
  }
  return {
    id: prev.id || newId('g'),
    subjectId: str(b.subjectId, 60),
    title, description: str(b.description, 300),
    pages: Math.max(Number(b.pages) || 0, 0), url, size,
  };
}
const handleUpload = (req, res, next) => upload.single('file')(req, res, async (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fayl 50 MB dan katta' : err.message });
  if (mongo && req.file) {
    try {
      if (!str(req.body.title)) return res.status(400).json({ error: 'Qo\'llanma nomi kiritilmagan' });
      req.file.filename = pdfName(req.file.originalname);
      await gridPut(req.file.buffer, req.file.filename);
      req.file.buffer = null;
    } catch (e) {
      return res.status(500).json({ error: 'Faylni bazaga saqlab bo\'lmadi: ' + e.message });
    }
  }
  next();
});
admin.post('/guides', handleUpload, wrap((req, res) => {
  const g = guideFromBody(req.body, req.file);
  db.guides.push(g); saveDb(); res.json(g);
}));
admin.put('/guides/:id', handleUpload, wrap((req, res) => {
  const i = db.guides.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw new Error('Qo\'llanma topilmadi');
  const prev = db.guides[i];
  const g = guideFromBody(req.body, req.file, prev);
  if (prev.url !== g.url) removeUpload(prev.url);
  db.guides[i] = g; saveDb(); res.json(g);
}));
admin.delete('/guides/:id', wrap((req, res) => {
  const g = db.guides.find((x) => x.id === req.params.id);
  if (g) removeUpload(g.url);
  db.guides = db.guides.filter((x) => x.id !== req.params.id); saveDb(); res.json({ ok: true });
}));

// Ommaviy import (JSON): { subjects?, tests?, guides? } — bor bo'lsa yangilanadi, yo'q bo'lsa qo'shiladi
admin.post('/import', wrap((req, res) => {
  const b = req.body || {};
  const counts = { subjects: 0, tests: 0, guides: 0 };
  const errors = [];
  for (const s of b.subjects || []) {
    try {
      const v = validateSubject(s, s.id ? slug(s.id) : undefined);
      const i = db.subjects.findIndex((x) => x.id === v.id);
      if (i >= 0) db.subjects[i] = v; else db.subjects.push(v);
      counts.subjects++;
    } catch (e) { errors.push(`Fan "${s.name || '?'}": ${e.message}`); }
  }
  for (const t of b.tests || []) {
    try {
      const v = validateTest(t, t.id ? str(t.id, 40) : undefined);
      const i = db.tests.findIndex((x) => x.id === v.id);
      if (i >= 0) db.tests[i] = v; else db.tests.push(v);
      counts.tests++;
    } catch (e) { errors.push(`Test "${t.title || '?'}": ${e.message}`); }
  }
  for (const g of b.guides || []) {
    try {
      const v = guideFromBody(g, null, { id: g.id ? str(g.id, 40) : undefined });
      const i = db.guides.findIndex((x) => x.id === v.id);
      if (i >= 0) db.guides[i] = v; else db.guides.push(v);
      counts.guides++;
    } catch (e) { errors.push(`Qo'llanma "${g.title || '?'}": ${e.message}`); }
  }
  saveDb();
  res.json({ ok: true, counts, errors });
}));

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi' }));

/* ---- Statik fayllar ---- */
app.get('/uploads/:name', async (req, res, next) => {
  if (!mongo) return next();
  try {
    const name = path.basename(req.params.name);
    const [file] = await mongo.bucket.find({ filename: name }).limit(1).toArray();
    if (!file) return res.status(404).send('Fayl topilmadi');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    mongo.bucket.openDownloadStream(file._id).on('error', () => res.end()).pipe(res);
  } catch (e) { next(e); }
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: (res) => res.setHeader('Content-Type', 'application/pdf') }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'public', 'index.html')));

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ ZERNO ishga tushdi: http://localhost:${PORT}`);
      console.log(`   Admin panel:        http://localhost:${PORT}/admin`);
    });
  })
  .catch((e) => {
    console.error('❌ Ma\'lumotlar bazasiga ulanib bo\'lmadi:', e.message);
    console.error('   MONGODB_URI to\'g\'riligini va Atlas → Network Access\'da 0.0.0.0/0 ruxsat etilganini tekshiring.');
    process.exit(1);
  });
