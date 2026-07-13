const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 5000;

const UPLOAD_ROOT = path.join(__dirname, 'uploads', 'lms');
const QUIZ_ROOT   = path.join(__dirname, 'data', 'quizzes');
fs.mkdirSync(QUIZ_ROOT, { recursive: true });
const TYPE_DIRS = { video: 'videos', audio: 'audio', document: 'documents' };
const ALLOWED_MIME = {
  video: /^video\//,
  audio: /^audio\//,
  document: /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument|application\/vnd\.ms-powerpoint|text\/plain)/,
};

for (const dir of Object.values(TYPE_DIRS)) {
  fs.mkdirSync(path.join(UPLOAD_ROOT, dir), { recursive: true });
}

function safeFilename(originalName) {
  const ext = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, '');
  const base = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .slice(0, 80);
  return `${Date.now()}-${base}${ext}`;
}

// Turns a Module/Class name into a safe folder name (falls back to "Unassigned").
function slugifyFolder(name) {
  const slug = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return slug || 'Unassigned';
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const type = req.params.type;
    const dir = TYPE_DIRS[type];
    if (!dir) return cb(new Error('Unknown upload type: ' + type));
    // req.body is only populated for fields multer has already parsed — the client
    // sends `module`/`cls` before the file field so they're available here.
    const modDir = slugifyFolder(req.body.module);
    const clsDir = slugifyFolder(req.body.cls);
    const relDir = path.join(dir, modDir, clsDir);
    req._uploadRelDir = relDir;
    const destDir = path.join(UPLOAD_ROOT, relDir);
    fs.mkdirSync(destDir, { recursive: true });
    cb(null, destDir);
  },
  filename: function (req, file, cb) {
    cb(null, safeFilename(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const type = req.params.type;
    const pattern = ALLOWED_MIME[type];
    if (!pattern) return cb(new Error('Unknown upload type: ' + type));
    if (!pattern.test(file.mimetype)) {
      return cb(new Error(`File type "${file.mimetype}" not allowed for ${type} upload`));
    }
    cb(null, true);
  },
});

app.post('/api/lms/upload/:type', function (req, res) {
  const type = req.params.type;
  if (!TYPE_DIRS[type]) return res.status(400).json({ error: 'Unknown upload type: ' + type });

  upload.single('file')(req, res, function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const relDir = req._uploadRelDir || TYPE_DIRS[type];
    res.json({ url: `/uploads/lms/${relDir.split(path.sep).join('/')}/${req.file.filename}` });
  });
});

// *rest captures "module-slug/class-slug/filename.ext" (or just "filename.ext" for
// older flat uploads made before folders were introduced). Express 5 / path-to-regexp
// v6 returns a named splat as an array of segments, hence the join('/') below.
app.delete('/api/lms/upload/:type/*rest', function (req, res) {
  const type = req.params.type;
  const dir = TYPE_DIRS[type];
  if (!dir) return res.status(400).json({ error: 'Unknown upload type: ' + type });

  const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : (req.params.rest || '');
  const typeRoot = path.join(UPLOAD_ROOT, dir);
  const filePath = path.join(typeRoot, rest);
  // Guard against path traversal — resolved path must stay inside this type's folder.
  if (!filePath.startsWith(typeRoot + path.sep) && filePath !== typeRoot) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  fs.unlink(filePath, function (err) {
    if (err && err.code !== 'ENOENT') return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ── Quiz storage: one quiz.json per Module/Class, organized the same way as uploads ──
app.use('/api/lms/quizzes', express.json({ limit: '2mb' }));

function _walkQuizFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push.apply(out, _walkQuizFiles(full));
    } else if (entry.isFile() && entry.name === 'quiz.json') {
      try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch (e) { /* skip corrupt file */ }
    }
  }
  return out;
}

app.get('/api/lms/quizzes', function (req, res) {
  res.json({ quizzes: _walkQuizFiles(QUIZ_ROOT) });
});

app.post('/api/lms/quizzes', function (req, res) {
  const body = req.body || {};
  const prevModule  = body.prevModule, prevCls = body.prevCls;
  const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : 0;
  const quiz = Object.assign({}, body);
  delete quiz.prevModule;
  delete quiz.prevCls;
  delete quiz.baseVersion;
  if (!quiz.module || !quiz.cls) return res.status(400).json({ error: 'module and cls are required' });

  const modDir   = slugifyFolder(quiz.module);
  const clsDir   = slugifyFolder(quiz.cls);
  const destDir  = path.join(QUIZ_ROOT, modDir, clsDir);
  const destFile = path.join(destDir, 'quiz.json');
  const isMove   = !!(prevModule && prevCls && (prevModule !== quiz.module || prevCls !== quiz.cls));

  function readJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  // Reject stale saves outright instead of guessing — whoever's edit started
  // from an older copy has to reload and redo it, so nobody's changes get
  // silently dropped and no two saves can ever race into a lost update.
  const checkPath = isMove
    ? path.join(QUIZ_ROOT, slugifyFolder(prevModule), slugifyFolder(prevCls), 'quiz.json')
    : destFile;
  const existing = readJsonSafe(checkPath);
  if (existing && (existing.version || 0) > baseVersion) {
    return res.status(409).json({
      error: 'This quiz was changed by someone else since you started editing. Reload and try again.',
      current: existing
    });
  }
  // Moving a quiz onto a class that already has a *different* quiz would
  // silently overwrite it — block that instead of clobbering.
  if (isMove) {
    const destExisting = readJsonSafe(destFile);
    if (destExisting && destExisting.id !== quiz.id) {
      return res.status(409).json({
        error: '"' + quiz.module + ' – ' + quiz.cls + '" already has a different quiz. Choose another class or remove that one first.'
      });
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(quiz, null, 2));

  // Quiz moved to a different module/class while editing — clean up the old file
  // so it doesn't linger as an orphaned duplicate.
  if (isMove) {
    const oldPath = path.join(QUIZ_ROOT, slugifyFolder(prevModule), slugifyFolder(prevCls), 'quiz.json');
    fs.unlink(oldPath, function () {});
  }

  res.json({ ok: true, path: modDir + '/' + clsDir + '/quiz.json' });
});

app.delete('/api/lms/quizzes/:module/:cls', function (req, res) {
  const filePath = path.join(QUIZ_ROOT, slugifyFolder(req.params.module), slugifyFolder(req.params.cls), 'quiz.json');
  fs.unlink(filePath, function (err) {
    if (err && err.code !== 'ENOENT') return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.use('/uploads/lms', express.static(UPLOAD_ROOT));
app.use(express.static(__dirname, { extensions: ['html'] }));

app.use('/api', function (req, res) {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, function () {
  console.log(`SeaTrace LMS server listening on port ${PORT}`);
});
