const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 5000;

const UPLOAD_ROOT = path.join(__dirname, 'uploads', 'lms');
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

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const type = req.params.type;
    const dir = TYPE_DIRS[type];
    if (!dir) return cb(new Error('Unknown upload type: ' + type));
    cb(null, path.join(UPLOAD_ROOT, dir));
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
    const dir = TYPE_DIRS[type];
    res.json({ url: `/uploads/lms/${dir}/${req.file.filename}` });
  });
});

app.delete('/api/lms/upload/:type/:filename', function (req, res) {
  const type = req.params.type;
  const dir = TYPE_DIRS[type];
  if (!dir) return res.status(400).json({ error: 'Unknown upload type: ' + type });

  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_ROOT, dir, filename);
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
