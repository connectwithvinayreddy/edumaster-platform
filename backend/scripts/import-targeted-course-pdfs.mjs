import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const workspaceRoot = path.resolve(process.cwd());
const packageDirValue = String(
  process.env.TARGET_PDF_PACKAGE_DIR
  || process.argv[2]
  || '',
).trim();
const targetPrivateUploadsRootValue = String(
  process.env.TARGET_PRIVATE_UPLOADS_ROOT
  || process.argv[3]
  || path.join(workspaceRoot, 'private_uploads'),
).trim();

const resolvePackageDir = () => {
  if (!packageDirValue) {
    throw new Error('TARGET_PDF_PACKAGE_DIR is required.');
  }
  return path.isAbsolute(packageDirValue)
    ? packageDirValue
    : path.resolve(workspaceRoot, packageDirValue);
};

const resolvePrivateUploadsRoot = () => (
  path.isAbsolute(targetPrivateUploadsRootValue)
    ? targetPrivateUploadsRootValue
    : path.resolve(workspaceRoot, targetPrivateUploadsRootValue)
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

const resolveDestinationRelativePath = (storagePath, fileName) => {
  const normalized = String(storagePath || '').trim().replace(/\\/g, '/');
  if (normalized.includes('/private_uploads/')) {
    return normalized.split('/private_uploads/').pop() || `course-pdfs/${fileName}`;
  }
  if (normalized.startsWith('private_uploads/')) {
    return normalized.slice('private_uploads/'.length);
  }
  if (normalized.startsWith('course-pdfs/')) {
    return normalized;
  }
  return path.posix.join('course-pdfs', fileName);
};

const main = async () => {
  const packageDir = resolvePackageDir();
  const privateUploadsRoot = resolvePrivateUploadsRoot();
  const manifestPath = path.join(packageDir, 'attachment-manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const attachments = Array.isArray(manifest?.attachments) ? manifest.attachments : [];
  if (!attachments.length) {
    throw new Error(`No attachments were found in ${manifestPath}`);
  }

  const imported = [];
  for (const attachment of attachments) {
    const packageRelativePath = String(attachment.packageRelativePath || '').trim();
    const sourcePath = path.join(packageDir, packageRelativePath);
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Packaged PDF is missing: ${sourcePath}`);
    }

    const sourceChecksum = await sha256File(sourcePath);
    if (sourceChecksum !== String(attachment.sha256 || '').trim()) {
      throw new Error(`Checksum mismatch in package for ${attachment.attachmentId}: expected ${attachment.sha256}, got ${sourceChecksum}`);
    }

    const destinationRelativePath = resolveDestinationRelativePath(attachment.storagePath, attachment.fileName || path.basename(sourcePath));
    const destinationPath = path.join(privateUploadsRoot, destinationRelativePath);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.copyFile(sourcePath, destinationPath);
    const destinationChecksum = await sha256File(destinationPath);
    if (destinationChecksum !== sourceChecksum) {
      throw new Error(`Imported checksum mismatch for ${attachment.attachmentId}: ${destinationChecksum}`);
    }

    imported.push({
      attachmentId: attachment.attachmentId,
      storagePath: attachment.storagePath,
      destinationPath,
      sha256: destinationChecksum,
      byteLength: stat.size,
    });
  }

  const report = {
    ok: true,
    importedAt: new Date().toISOString(),
    packageDir,
    privateUploadsRoot,
    importedCount: imported.length,
    imported,
  };

  await fsp.writeFile(path.join(packageDir, 'import-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
