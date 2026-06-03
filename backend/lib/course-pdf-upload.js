const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(process.cwd(), 'private_uploads', 'course-pdfs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const extension = path.extname(String(file.originalname || '')).toLowerCase() || '.pdf';
    const safeBaseName = path.basename(String(file.originalname || 'document.pdf'), extension)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      || 'document';
    cb(null, `${Date.now()}-${safeBaseName}${extension === '.pdf' ? extension : '.pdf'}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const originalName = String(file.originalname || '').toLowerCase();
    const isPdfMime = String(file.mimetype || '').toLowerCase() === 'application/pdf';
    const isPdfExtension = originalName.endsWith('.pdf');
    if (!isPdfMime && !isPdfExtension) {
      cb(new Error('Only PDF files are allowed'));
      return;
    }
    cb(null, true);
  },
});

module.exports = upload;
module.exports.uploadDir = uploadDir;
