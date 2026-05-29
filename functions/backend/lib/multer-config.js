// Multer configuration for video uploads
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { appConfig } = require('./config.js');

const uploadDir = path.join(__dirname, '../../uploads/videos');

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  },
});

const allowedMimes = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'application/x-matroska',
];
const allowedExtensions = new Set(['.mp4', '.webm', '.ogg', '.mov', '.mkv']);

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (allowedMimes.includes(file.mimetype) || allowedExtensions.has(extension)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: MP4, WebM, OGG, MOV, MKV'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: appConfig.maxVideoUploadMb * 1024 * 1024,
  },
});

const chunkUpload = multer({
  storage,
  limits: {
    fileSize: appConfig.maxVideoUploadMb * 1024 * 1024,
  },
});

module.exports = upload;
module.exports.chunkUpload = chunkUpload;
module.exports.uploadDir = uploadDir;
