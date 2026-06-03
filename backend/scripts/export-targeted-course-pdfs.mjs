import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { connectDatabase } from '../lib/database.js';

const require = createRequire(import.meta.url);
const { coursesRepository } = require('../lib/repositories.js');

const workspaceRoot = path.resolve(process.cwd());
const targetsFileValue = String(
  process.env.QA_STREAM_CERT_TARGETS_FILE
  || process.env.TARGETS_FILE
  || process.argv[2]
  || '',
).trim();
const outputDirValue = String(
  process.env.TARGET_PDF_PACKAGE_DIR
  || process.argv[3]
  || path.join(workspaceRoot, 'tmp', `targeted-course-pdfs-package-${new Date().toISOString().replace(/[:.]/g, '-')}`),
).trim();

const resolveTargetsPath = () => {
  if (!targetsFileValue) {
    throw new Error('QA_STREAM_CERT_TARGETS_FILE or TARGETS_FILE is required.');
  }
  return path.isAbsolute(targetsFileValue)
    ? targetsFileValue
    : path.resolve(workspaceRoot, targetsFileValue);
};

const requireString = (value, field) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`Missing required target field: ${field}`);
  }
  return normalized;
};

const loadTargets = async () => {
  const targetsPath = resolveTargetsPath();
  const payload = JSON.parse(await fsp.readFile(targetsPath, 'utf8'));
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Expected ${targetsPath} to contain a non-empty JSON array.`);
  }
  return payload.map((entry, index) => ({
    key: requireString(entry?.key || `target-${index + 1}`, `targets[${index}].key`),
    courseId: requireString(entry?.courseId, `targets[${index}].courseId`),
    courseText: requireString(entry?.courseText, `targets[${index}].courseText`),
    lessonId: requireString(entry?.lessonId, `targets[${index}].lessonId`),
    lessonText: requireString(entry?.lessonText, `targets[${index}].lessonText`),
    pdfAttachmentId: requireString(entry?.pdfAttachmentId, `targets[${index}].pdfAttachmentId`),
    pdfAttachmentTitle: String(entry?.pdfAttachmentTitle || '').trim() || null,
  }));
};

const findAttachmentInCourse = (course, attachmentId) => {
  for (const module of course.modules || []) {
    for (const attachment of module.attachments || []) {
      if (attachment.id === attachmentId) {
        return { scope: 'module', title: attachment.title || module.title || 'Module PDF', attachment };
      }
    }
    for (const lesson of module.lessons || []) {
      for (const attachment of lesson.attachments || []) {
        if (attachment.id === attachmentId) {
          return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF', attachment };
        }
      }
    }
    for (const chapter of module.chapters || []) {
      for (const attachment of chapter.attachments || []) {
        if (attachment.id === attachmentId) {
          return { scope: 'chapter', title: attachment.title || chapter.title || 'Chapter PDF', attachment };
        }
      }
      for (const lesson of chapter.lessons || []) {
        for (const attachment of lesson.attachments || []) {
          if (attachment.id === attachmentId) {
            return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF', attachment };
          }
        }
      }
    }
  }
  return null;
};

const normalizeStoragePath = (storagePath) => {
  const raw = String(storagePath || '').trim();
  if (!raw) {
    throw new Error('Attachment storagePath is missing.');
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
};

const resolveSourceFilePath = (storagePath) => (
  path.isAbsolute(storagePath)
    ? storagePath
    : path.join(workspaceRoot, storagePath)
);

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
};

const main = async () => {
  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const targets = await loadTargets();
  const outputDir = path.isAbsolute(outputDirValue)
    ? outputDirValue
    : path.resolve(workspaceRoot, outputDirValue);
  const filesRoot = path.join(outputDir, 'files');
  const attachments = [];

  await fsp.mkdir(filesRoot, { recursive: true });

  for (const target of targets) {
    const course = await coursesRepository.findById(target.courseId);
    if (!course) {
      throw new Error(`Course not found for target ${target.key}: ${target.courseId}`);
    }
    const match = findAttachmentInCourse(course, target.pdfAttachmentId);
    if (!match) {
      throw new Error(`Attachment ${target.pdfAttachmentId} was not found in course ${target.courseId} (${target.courseText}).`);
    }

    const storagePath = normalizeStoragePath(match.attachment.storagePath);
    const sourceFilePath = resolveSourceFilePath(storagePath);
    const stat = await fsp.stat(sourceFilePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Stored PDF file is missing for ${target.key}: ${sourceFilePath}`);
    }

    const packageRelativePath = path.posix.join('files', storagePath.replace(/^\/+/, ''));
    const destinationFilePath = path.join(outputDir, packageRelativePath);
    await fsp.mkdir(path.dirname(destinationFilePath), { recursive: true });
    await fsp.copyFile(sourceFilePath, destinationFilePath);
    const checksum = await sha256File(destinationFilePath);

    attachments.push({
      targetKey: target.key,
      courseId: target.courseId,
      courseText: target.courseText,
      lessonId: target.lessonId,
      lessonText: target.lessonText,
      attachmentId: target.pdfAttachmentId,
      attachmentTitle: target.pdfAttachmentTitle || match.title,
      scope: match.scope,
      fileName: String(match.attachment.fileName || path.basename(storagePath)).trim() || path.basename(storagePath),
      storagePath,
      packageRelativePath,
      byteLength: stat.size,
      sha256: checksum,
    });
  }

  const manifest = {
    ok: true,
    exportedAt: new Date().toISOString(),
    targetManifestPath: resolveTargetsPath(),
    outputDir,
    attachmentCount: attachments.length,
    attachments,
  };

  await fsp.writeFile(path.join(outputDir, 'attachment-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.writeFile(
    path.join(outputDir, 'checksum-report.json'),
    JSON.stringify({
      ok: true,
      exportedAt: manifest.exportedAt,
      checksums: attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        storagePath: attachment.storagePath,
        sha256: attachment.sha256,
      })),
    }, null, 2),
    'utf8',
  );

  console.log(JSON.stringify(manifest, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
