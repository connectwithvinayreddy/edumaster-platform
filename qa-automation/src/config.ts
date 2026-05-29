import path from 'node:path';
import { RunConfig } from './types.js';

export const config: RunConfig = {
  baseUrl: process.env.QA_BASE_URL || 'http://10.0.2.2:3000',
  appiumHost: process.env.QA_APPIUM_HOST || '127.0.0.1',
  appiumPort: Number(process.env.QA_APPIUM_PORT || 4723),
  androidDeviceName: process.env.QA_ANDROID_DEVICE || 'Android Emulator',
  browserName: process.env.QA_BROWSER_NAME || 'Chrome',
  loginEmail: process.env.QA_LOGIN_EMAIL || '',
  loginPassword: process.env.QA_LOGIN_PASSWORD || 'Student@123',
  slowThresholdMs: Number(process.env.QA_SLOW_MS || 6000),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
};

const currentWorkingDirectory = process.cwd();

export const automationRoot = path.basename(currentWorkingDirectory) === 'qa-automation'
  ? currentWorkingDirectory
  : path.resolve(currentWorkingDirectory, 'qa-automation');
