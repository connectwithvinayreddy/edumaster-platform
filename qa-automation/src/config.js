"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.automationRoot = exports.config = void 0;
var node_path_1 = require("node:path");
exports.config = {
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
var currentWorkingDirectory = process.cwd();
exports.automationRoot = node_path_1.default.basename(currentWorkingDirectory) === 'qa-automation'
    ? currentWorkingDirectory
    : node_path_1.default.resolve(currentWorkingDirectory, 'qa-automation');
