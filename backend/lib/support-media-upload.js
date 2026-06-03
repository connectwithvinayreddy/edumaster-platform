const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../../uploads/support-media');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedMimePrefixes = ['image/', 'video/', 'audio/'];
const allowedExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mkv',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const name = path.basename(file.originalname || 'support-file', ext).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'support-file';
    cb(null, `${name}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const isAllowedMime = allowedMimePrefixes.some((prefix) => String(file.mimetype || '').startsWith(prefix));
  if (isAllowedMime || allowedExtensions.has(extension)) {
    cb(null, true);
    return;
  }
  cb(new Error('Invalid support file type. Allowed: images, videos, and audio files.'), false);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

module.exports.uploadDir = uploadDir;
