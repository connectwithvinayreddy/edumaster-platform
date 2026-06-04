import fs from 'node:fs/promises';
import path from 'node:path';
import { automationRoot } from './config.js';
import { RunContext } from './types.js';

const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
};

export const createRunContext = async (): Promise<RunContext> => {
  const runId = (process.env.QA_RUN_ID_OVERRIDE || '').trim()
    || new Date().toISOString().replace(/[:.]/g, '-');
  const rootDir = path.join(automationRoot, 'artifacts', runId);
  const screenshotDir = path.join(rootDir, 'screenshots');
  const sourceDir = path.join(rootDir, 'sources');
  const logDir = path.join(rootDir, 'logs');
  const analysisDir = path.join(rootDir, 'analysis');
  const flutterDir = path.join(rootDir, 'generated_flutter');

  await Promise.all([screenshotDir, sourceDir, logDir, analysisDir, flutterDir].map(ensureDir));

  return { runId, rootDir, screenshotDir, sourceDir, logDir, analysisDir, flutterDir };
};

export const artifactPath = (root: string, prefix: string, label: string, extension: string) =>
  path.join(root, `${prefix}-${safe(label)}.${extension}`);

export const writeJson = async (filePath: string, data: unknown) => {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

export const writeText = async (filePath: string, value: string) => {
  await fs.writeFile(filePath, value, 'utf8');
};
