const express = require('express'), multer = require('multer'), { createClient } = require('@libsql/client');
const crypto = require('crypto'), path = require('path'), fs = require('fs');

const ROOT = path.join(__dirname, '..');

// ---- Constants (single source of truth, enforced server-side) ----
// Two groups, each A-Z: first 57 students, then the next 8
const STUDENTS = ['AAYISHA SIDDIQUA S',
  'ABHINAV S',
  'AVANTHIKA L R',
  'CHARULEKHA S J',
  'DINESH P',
  'GAYATHRI S',
  'GIRIJA DEVI P',
  'GOKULAPRIYA S',
  'GOPIKASRI S',
  'GOPINATH M',
  'HARIKRISHNAN V',
  'JAYASOORYA R',
  'JOYSON ATHISAYA KUMAR J',
  'KABILESH PANDIAN S',
  'KAMALI R',
  'KANISHKAR K P',
  'KARTHIKA U',
  'KAUSHIKKUMAR V',
  'KEERTHANA N',
  'KISHORE KUMAR V',
  'KOPINATH D',
  'KRITIKA M S',
  'LISHANTH D',
  'MAHITHA SHIREE A S',
  'MATHAN B',
  'MEGANTH JD',
  'MOHAMED ASHIF S',
  'MONIKA S',
  'MONIKA T',
  'MUHAMMAD FADIL M',
  'MUHAMMED SENIN CM',
  'NAVEENA M',
  'NITHISH G',
  'OVIYA S D',
  'PRANEETHA KRISHNAN SANGEETHA',
  'PRIYADHARSHINI M D',
  'PUSHPANATHAN T',
  'RATISH KUMAR A',
  'REKHA M',
  'RENUGA DEVI K',
  'ROHITH RAJ P',
  'SAGANA K',
  'SAHAYA KEERTHIGA K',
  'SAKTHIVEL M',
  'SANJAI GOPALAKRISHNAN',
  'SARATHY R',
  'SHATHVIKA A M',
  'SIBIRAJAN N',
  'SRIPALAVESH M',
  'SUWATHIKAA S S',
  'THANISH DRAVIN K',
  'VANITHA S',
  'VARSHA PONSHREE L',
  'VARUNIKA DEVI P',
  'VIBISHAN S',
  'VIKASH M R',
  'VIMAL IGNATIUS JOSHUA J',
  'AMSAPRIYA I',
  'BOOPATHI RAGAVAN K S',
  'CHARLES DARWIN S',
  'GOKUL R',
  'KATHIRVEL S',
  'SAI KRISHNA CHAITANYA G',
  'SAI SABARI T M',
  'SANJITH D'];
// Last 8 students are the second group (lateral entry): roll 25CHL058-066, email *.26chem@kongu.edu
const LATERAL_START = 57;
const LATERAL = STUDENTS.slice(LATERAL_START);
const groupOf = name => LATERAL.includes(name)
  ? { roll: '25CHL0', min: 58, max: 66, domain: '.26chem@kongu.edu' }
  : { roll: '25CHR0', min: 1, max: 57, domain: '.25chem@kongu.edu' };
const SEMESTERS = [3, 4, 5, 6, 7, 8];                      // no Semester 1 or 2
const ACTIVITIES = ['Symposium', 'National Conference', 'International Conference', 'Hackathon', 'Paper Presentation', 'Other'];
const PRIZES = ['I', 'II', 'III', 'IV', 'Participation', 'Other'];
const ADMIN_USER = process.env.ADMIN_USER || 'StdSAP';
const ADMIN_PASS = process.env.ADMIN_PASS || 'sap2529';

// ---- Database (Turso / libSQL; falls back to a local file for development) ----
// Certificates are stored inside the database, so no persistent disk is needed on the host.
let dbUrl = process.env.TURSO_DATABASE_URL;
if (!dbUrl) {
  fs.mkdirSync(path.join(ROOT, 'database'), { recursive: true });
  dbUrl = 'file:' + path.join(ROOT, 'database', 'sap.db');
}
const db = createClient({ url: dbUrl, authToken: process.env.TURSO_AUTH_TOKEN });
const plain = r => Object.fromEntries(Object.keys(r).filter(k => isNaN(k)).map(k => [k, r[k]]));
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows.map(plain);
const get = async (sql, args = []) => (await all(sql, args))[0];
const run = (sql, args = []) => db.execute({ sql, args });

const SUB_COLS = `id,student_id,semester,roll_no,email,activity_type,other_activity,event_name,college_attended,paper_title,
  from_date,to_date,no_of_days,prize,other_prize,created_at,claim_status,claimed_points,claimed_at,updated_at`;
const SUB_COLS_S = SUB_COLS.split(',').map(c => 's.' + c.trim()).join(',');

async function init() {
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, roll_no TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  semester INTEGER NOT NULL CHECK(semester IN (3,4,5,6,7,8)),
  roll_no TEXT NOT NULL, email TEXT NOT NULL,
  activity_type TEXT NOT NULL, other_activity TEXT,
  event_name TEXT NOT NULL, college_attended TEXT NOT NULL, paper_title TEXT NOT NULL,
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, no_of_days INTEGER NOT NULL,
  prize TEXT NOT NULL, other_prize TEXT, certificate BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claim_status TEXT NOT NULL DEFAULT 'pending' CHECK(claim_status IN ('pending','claimed')),
  claimed_points REAL NOT NULL DEFAULT 0,
  claimed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_sub_student_sem ON submissions(student_id, semester);`);
  await db.batch(STUDENTS.map(n => ({ sql: 'INSERT OR IGNORE INTO students(name) VALUES(?)', args: [n] })), 'write');
}
const STUDENT_MARKS = STUDENTS.map(() => '?').join(',');

const stats = (sid, sem) => get(`
  SELECT COALESCE(SUM(claim_status='pending'),0) AS pending,
         COALESCE(SUM(claim_status='claimed'),0) AS claimed,
         COALESCE(SUM(CASE WHEN claim_status='claimed' THEN claimed_points END),0) AS total_points
  FROM submissions WHERE student_id=? AND semester=?`, [sid, sem]);

// "Symposium", "Symposium (2)", ... per student+semester; DB id stays the real key
function withLabels(rows) {
  const seen = {};
  return rows.map(r => {
    const base = r.activity_type === 'Other' ? r.other_activity : r.activity_type;
    seen[base] = (seen[base] || 0) + 1;
    return { ...r, label: seen[base] > 1 ? `${base} (${seen[base]})` : base };
  });
}
const publicSub = r => ({ ...r, certificate_url: `/api/admin/submissions/${r.id}/certificate` });
const labelled = async id => {
  const s = await get('SELECT student_id, semester FROM submissions WHERE id=?', [id]);
  if (!s) return null;
  const rows = withLabels(await all(`SELECT ${SUB_COLS_S}, st.name AS student_name FROM submissions s JOIN students st ON st.id=s.student_id WHERE student_id=? AND semester=? ORDER BY s.id`, [s.student_id, s.semester]));
  return rows.find(r => r.id === id);
};

// ---- Admin sessions (server-side, HttpOnly cookie) ----
const sessions = new Map(), fails = new Map();
const sessionOf = req => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const exp = m && sessions.get(m[1]);
  if (exp && exp > Date.now()) return m[1];
  if (m) sessions.delete(m[1]);
  return null;
};
const requireApi = (req, res, next) => sessionOf(req) ? next() : res.status(401).json({ error: 'Not authenticated' });
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- App ----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // behind Render's proxy: correct client IP for login rate limiting
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); next(); });
app.use('/assets', express.static(path.join(ROOT, 'client', 'assets')));

// Pages
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.sendFile(path.join(ROOT, 'client', 'index.html')));
app.get(['/admin', '/admin/'], (req, res) =>
  sessionOf(req) ? res.redirect('/admin/dashboard') : res.sendFile(path.join(ROOT, 'admin', 'admin.html')));
app.get('/admin/*', (req, res) =>
  sessionOf(req) ? res.sendFile(path.join(ROOT, 'admin', 'admin.html')) : res.redirect('/admin'));

// Public API
app.get('/api/config', (_, res) => res.json({ students: STUDENTS, lateral: LATERAL, semesters: SEMESTERS, activities: ACTIVITIES, prizes: PRIZES }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const parseDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null; const d = new Date(s + 'T00:00:00Z'); return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : d; };

app.post('/api/submissions', (req, res, next) => {
  upload.single('certificate')(req, res, async err => {
    try {
      if (err) return res.status(400).json({ errors: [err.code === 'LIMIT_FILE_SIZE' ? 'Certificate must be 10 MB or smaller.' : 'Upload failed.'] });
      const b = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v).trim()]));
      const e = [], text = (k, label, max = 200) => { if (!b[k]) e.push(`${label} is required.`); else if (b[k].length > max) e.push(`${label} is too long.`); };
      const student = STUDENTS.includes(b.student_name) ? await get('SELECT * FROM students WHERE name=?', [b.student_name]) : null;
      if (!student) e.push('Invalid student name.');
      const g = groupOf(b.student_name), rm = /^(25CH[RL]0)(\d{2})$/.exec(b.roll_no || '');
      if (!rm || rm[1] !== g.roll || +rm[2] < g.min || +rm[2] > g.max)
        e.push(`Roll number must be ${g.roll}${String(g.min).padStart(2, '0')} to ${g.roll}${g.max}.`);
      const um = /^([a-z0-9._-]+)(\.2[56]chem@kongu\.edu)$/i.exec(b.email || '');
      if (!um || um[2].toLowerCase() !== g.domain) e.push(`Email must be username${g.domain}.`);
      const sem = /^\d+$/.test(b.semester || '') ? Number(b.semester) : NaN;
      if (!SEMESTERS.includes(sem)) e.push('Semester must be one of 3, 4, 5, 6, 7, 8.');
      if (!ACTIVITIES.includes(b.activity_type)) e.push('Invalid nature of activity.');
      if (b.activity_type === 'Other') text('other_activity', 'Other activity');
      text('event_name', 'Event name'); text('college_attended', 'College name'); text('paper_title', 'Paper title', 300);
      if (!PRIZES.includes(b.prize)) e.push('Invalid prize.');
      if (b.prize === 'Other') text('other_prize', 'Other prize');
      const f = parseDate(b.from_date), t = parseDate(b.to_date);
      if (!f || !t) e.push('From and To dates must be valid dates.');
      else if (t < f) e.push('To date cannot be earlier than From date.');
      const pdf = req.file;
      if (!pdf) e.push('Certificate PDF is required.');
      else if (!/\.pdf$/i.test(pdf.originalname) || pdf.mimetype !== 'application/pdf' || pdf.buffer.slice(0, 5).toString() !== '%PDF-') e.push('Certificate must be a PDF file.');
      if (e.length) return res.status(400).json({ errors: e });

      const days = Math.round((t - f) / 864e5) + 1;
      const info = await run(`INSERT INTO submissions(student_id,semester,roll_no,email,activity_type,other_activity,event_name,college_attended,paper_title,from_date,to_date,no_of_days,prize,other_prize,certificate)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [student.id, sem, b.roll_no, b.email, b.activity_type,
        b.activity_type === 'Other' ? b.other_activity : null, b.event_name, b.college_attended, b.paper_title,
        b.from_date, b.to_date, days, b.prize, b.prize === 'Other' ? b.other_prize : null, pdf.buffer]);
      await run('UPDATE students SET roll_no=?, email=? WHERE id=?', [b.roll_no, b.email, student.id]);
      res.status(201).json({ id: Number(info.lastInsertRowid), message: 'Application submitted successfully. Your activity details and certificate have been saved.' });
    } catch (ex) { next(ex); }
  });
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip, rec = fails.get(ip) || { n: 0, until: 0 };
  if (rec.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { username = '', password = '' } = req.body || {};
  if (typeof username === 'string' && typeof password === 'string' && safeEq(username, ADMIN_USER) && safeEq(password, ADMIN_PASS)) {
    fails.delete(ip);
    const tok = crypto.randomBytes(32).toString('hex');
    sessions.set(tok, Date.now() + 8 * 3600e3);
    res.cookie('sid', tok, { httpOnly: true, sameSite: 'strict', maxAge: 8 * 3600e3, secure: process.env.NODE_ENV === 'production' });
    return res.json({ ok: true });
  }
  rec.n++; if (rec.n >= 8) { rec.n = 0; rec.until = Date.now() + 10 * 60e3; }
  fails.set(ip, rec);
  res.status(401).json({ error: 'Invalid username or password.' });
});
app.post('/api/admin/logout', (req, res) => { const s = sessionOf(req); if (s) sessions.delete(s); res.clearCookie('sid'); res.json({ ok: true }); });

// Admin data
const admin = express.Router();
admin.use(requireApi);
admin.get('/students', wrap(async (_, res) => {
  const rows = await all(`
  SELECT st.id, st.name, COUNT(s.id) AS submissions,
    COALESCE(SUM(s.claim_status='pending'),0) AS pending, COALESCE(SUM(s.claim_status='claimed'),0) AS claimed FROM students st LEFT JOIN submissions s ON s.student_id=st.id WHERE st.name IN (${STUDENT_MARKS}) GROUP BY st.id`, STUDENTS);
  res.json(rows.sort((x, y) => STUDENTS.indexOf(x.name) - STUDENTS.indexOf(y.name)));
}));
admin.get('/students/:id', wrap(async (req, res) => {
  const st = await get('SELECT id,name FROM students WHERE id=?', [req.params.id]);
  if (!st) return res.status(404).json({ error: 'Student not found' });
  res.json({ ...st, semesters: await Promise.all(SEMESTERS.map(async n => ({ semester: n, ...await stats(st.id, n) }))) });
}));
admin.get('/students/:id/semesters/:sem', wrap(async (req, res) => {
  const sem = Number(req.params.sem), st = await get('SELECT id,name FROM students WHERE id=?', [req.params.id]);
  if (!st || !SEMESTERS.includes(sem)) return res.status(404).json({ error: 'Not found' });
  const rows = withLabels(await all(`SELECT ${SUB_COLS} FROM submissions WHERE student_id=? AND semester=? ORDER BY id`, [st.id, sem]));
  res.json({ student: st, semester: sem, stats: await stats(st.id, sem), submissions: rows.map(publicSub) });
}));
admin.get('/submissions/:id', wrap(async (req, res) => {
  const r = await labelled(Number(req.params.id));
  r ? res.json(publicSub(r)) : res.status(404).json({ error: 'Submission not found' });
}));
const POINTS = /^\d+(\.\d{1,2})?$/;
admin.post('/submissions/:id/claim', wrap(async (req, res) => {   // claims, or updates points if already claimed (never duplicates)
  const id = Number(req.params.id), raw = req.body && req.body.points;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || !POINTS.test(String(raw).trim()) || Number(raw) <= 0 || Number(raw) > 100000)
    return res.status(400).json({ error: 'Please enter a valid SAP point value.' });
  if (!await get('SELECT 1 AS x FROM submissions WHERE id=?', [id])) return res.status(404).json({ error: 'Submission not found' });
  await run(`UPDATE submissions SET claim_status='claimed', claimed_points=?,
    claimed_at=CASE WHEN claim_status='claimed' THEN claimed_at ELSE datetime('now') END, updated_at=datetime('now') WHERE id=?`, [Number(raw), id]);
  res.json(publicSub(await labelled(id)));
}));
admin.post('/submissions/:id/unclaim', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await run(`UPDATE submissions SET claim_status='pending', claimed_points=0, claimed_at=NULL, updated_at=datetime('now') WHERE id=?`, [id]);
  r.rowsAffected ? res.json(publicSub(await labelled(id))) : res.status(404).json({ error: 'Submission not found' });
}));
admin.get('/submissions/:id/certificate', wrap(async (req, res) => {
  const r = await get('SELECT certificate FROM submissions WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).end();
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="certificate-${Number(req.params.id)}.pdf"` });
  res.send(Buffer.from(r.certificate));
}));
app.use('/api/admin', admin);
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Please try again.' }); });

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log(`SAP Points system running on http://localhost:${PORT}  (admin: /admin)`)))
  .catch(e => { console.error('Database init failed:', e); process.exit(1); });
