/**
 * ZERNO — Free Knowledge Hub
 * Backend: Node.js + Express, ma'lumotlar data/db.json faylida saqlanadi.
 *
 * Ishga tushirish:
 *   npm install
 *   ADMIN_TOKEN="kuchli-parol" npm start      (Linux/Mac)
 *   set ADMIN_TOKEN=kuchli-parol && npm start  (Windows CMD)
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

if (!ADMIN_TOKEN) {
  console.warn('\n⚠️  ADMIN_TOKEN o\'rnatilmagan — admin panel o\'chirilgan. Uni yoqish uchun ADMIN_TOKEN muhit o\'zgaruvchisini bering.\n');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- Ma'lumotlar bazasi (JSON fayl) ---------------- */
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = fs.existsSync(SEED_FILE)
      ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
      : { subjects: [], tests: [], guides: [], stats: { attempts: 0, students: [] } };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.subjects ||= []; db.tests ||= []; db.guides ||= [];
  db.stats ||= { attempts: 0, students: [] };
  db.stats.students ||= [];
  return db;
}
let db = loadDb();
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE); // atomik yozish
  }, 150);
}

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
    students: db.stats.students.length,
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

// Javoblarni tekshirish (serverda)
app.post('/api/tests/:id/submit', (req, res) => {
  const t = db.tests.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Test topilmadi' });
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const review = t.questions.map((q, i) => ({
    correct: q.correct,
    chosen: Number.isInteger(answers[i]) ? answers[i] : null,
  }));
  const score = review.filter((r) => r.chosen === r.correct).length;
  db.stats.attempts += 1;
  const cid = str(req.body.clientId, 64);
  if (cid && !db.stats.students.includes(cid)) db.stats.students.push(cid);
  saveDb();
  res.json({ score, total: t.questions.length, review, stats: publicStats() });
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
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${slug(path.parse(file.originalname).name) || 'fayl'}.pdf`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Faqat PDF fayl yuklash mumkin'), ok);
  },
});
function removeUpload(url) {
  if (url && url.startsWith('/uploads/')) {
    const f = path.join(UPLOAD_DIR, path.basename(url));
    fs.promises.unlink(f).catch(() => {});
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
const handleUpload = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fayl 50 MB dan katta' : err.message });
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

/* ---- Statik fayllar ---- */
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: (res) => res.setHeader('Content-Type', 'application/pdf') }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ ZERNO ishga tushdi: http://localhost:${PORT}`);
  console.log(`   Admin panel:        http://localhost:${PORT}/admin`);
});
