import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRecordedDeliveryPath, type RecordedDeliveryPath } from './recorded-delivery-path.js';

export type StreamCertTarget = {
  key: string;
  courseId: string;
  courseText: string;
  lessonId: string;
  lessonText: string;
  pdfAttachmentId: string;
  pdfAttachmentTitle: string | null;
  testId: string;
  testTitle: string | null;
  expectedDeliveryPath: RecordedDeliveryPath;
};

const workspaceRoot = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');

const normalizeKey = (value: string) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const requireNonEmptyString = (value: unknown, field: string) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`Missing required stream certification target field: ${field}`);
  }
  return normalized;
};

const normalizeExpectedDeliveryPath = (value: unknown) => {
  const normalized = normalizeRecordedDeliveryPath(value);
  return normalized || 'protected_hls_gateway';
};

const normalizeTarget = (value: unknown, index: number): StreamCertTarget => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Stream certification target at index ${index} must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const courseText = requireNonEmptyString(raw.courseText, `targets[${index}].courseText`);
  const lessonText = requireNonEmptyString(raw.lessonText, `targets[${index}].lessonText`);
  const key = normalizeKey(
    String(raw.key || raw.name || `${courseText}-${lessonText}`),
  );

  return {
    key: key || `target-${index + 1}`,
    courseId: requireNonEmptyString(raw.courseId, `targets[${index}].courseId`),
    courseText,
    lessonId: requireNonEmptyString(raw.lessonId, `targets[${index}].lessonId`),
    lessonText,
    pdfAttachmentId: requireNonEmptyString(raw.pdfAttachmentId, `targets[${index}].pdfAttachmentId`),
    pdfAttachmentTitle: String(raw.pdfAttachmentTitle || '').trim() || null,
    testId: requireNonEmptyString(raw.testId, `targets[${index}].testId`),
    testTitle: String(raw.testTitle || '').trim() || null,
    expectedDeliveryPath: normalizeExpectedDeliveryPath(raw.expectedDeliveryPath),
  };
};

export const resolveStreamCertTargetsPath = () => {
  const requested = String(process.env.QA_STREAM_CERT_TARGETS_FILE || '').trim();
  if (!requested) {
    return '';
  }
  return path.isAbsolute(requested) ? requested : path.resolve(workspaceRoot, requested);
};

export const loadStreamCertTargets = async (): Promise<StreamCertTarget[]> => {
  const filePath = resolveStreamCertTargetsPath();
  if (!filePath) {
    throw new Error('QA_STREAM_CERT_TARGETS_FILE is required.');
  }

  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected ${filePath} to contain a JSON array of stream certification targets.`);
  }

  const targets = raw.map((entry, index) => normalizeTarget(entry, index));
  if (targets.length === 0) {
    throw new Error(`No stream certification targets were found in ${filePath}.`);
  }
  return targets;
};

export const getStreamCertTargetSelection = async () => {
  const targets = await loadStreamCertTargets();
  const requestedIndex = String(process.env.QA_STREAM_CERT_TARGET_INDEX || '').trim();
  const requestedKey = normalizeKey(String(process.env.QA_STREAM_CERT_TARGET_KEY || '').trim());

  let index = 0;
  if (requestedKey) {
    index = targets.findIndex((target) => target.key === requestedKey);
    if (index === -1) {
      throw new Error(`QA_STREAM_CERT_TARGET_KEY=${requestedKey} was not found in ${resolveStreamCertTargetsPath()}.`);
    }
  } else if (requestedIndex) {
    const parsed = Number(requestedIndex);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= targets.length) {
      throw new Error(`QA_STREAM_CERT_TARGET_INDEX=${requestedIndex} is out of range for ${targets.length} targets.`);
    }
    index = parsed;
  }

  return {
    targets,
    index,
    target: targets[index],
  };
};
