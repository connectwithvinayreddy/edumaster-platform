"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var node_child_process_1 = require("node:child_process");
var stream_cert_targets_js_1 = require("./stream-cert-targets.js");
var workspaceRoot = node_path_1.default.resolve(process.cwd(), node_path_1.default.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
var qaRoot = node_path_1.default.join(workspaceRoot, 'qa-automation');
var reportRoot = node_path_1.default.join(workspaceRoot, 'reports');
var latestReportDir = node_path_1.default.join(reportRoot, 'streaming-pdf-mixed-certification', 'latest');
var runId = new Date().toISOString().replace(/[:.]/g, '-');
var reportDir = node_path_1.default.join(reportRoot, "streaming-pdf-mixed-certification-".concat(runId));
var envFile = String(process.env.ENV_FILE || node_path_1.default.join(workspaceRoot, '.env.staging.private-mirror')).trim();
var baseUrl = String(process.env.QA_BASE_URL || '').trim();
var userPassword = String(process.env.PLATFORM_LOAD_USER_PASSWORD || process.env.QA_LOGIN_PASSWORD || 'Student@123').trim();
var browserStageCounts = String(process.env.QA_STREAM_CERT_BROWSER_STAGES || process.env.QA_STREAM_CERT_STAGES || '100,200')
    .split(',')
    .map(function (value) { return Number(value.trim()); })
    .filter(function (value) { return Number.isFinite(value) && value > 0; });
var syntheticVideoStageCounts = String(process.env.QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES || '1000,2000')
    .split(',')
    .map(function (value) { return Number(value.trim()); })
    .filter(function (value) { return Number.isFinite(value) && value > 0; });
var backgroundRatio = Math.max(0, Number(process.env.QA_STREAM_BACKGROUND_RATIO || 1));
var syntheticBackgroundUsers = Math.max(1, Number(process.env.QA_STREAM_CERT_SYNTHETIC_BACKGROUND_USERS || 200));
var screenshotSample = Math.max(6, Number(process.env.QA_VIDEO_BROWSER_SCREENSHOT_SAMPLE || 6));
var requestedTargetKey = String(process.env.QA_STREAM_CERT_TARGET_KEY || '').trim().toLowerCase();
var requestedTargetIndex = String(process.env.QA_STREAM_CERT_TARGET_INDEX || '').trim();
var ensureDir = function (dir) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, promises_1.default.mkdir(dir, { recursive: true })];
            case 1:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); };
var publishLatestArtifacts = function (summary) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, ensureDir(latestReportDir)];
            case 1:
                _a.sent();
                return [4 /*yield*/, promises_1.default.writeFile(node_path_1.default.join(latestReportDir, 'streaming-pdf-mixed-certification-summary.json'), JSON.stringify(summary, null, 2), 'utf8')];
            case 2:
                _a.sent();
                return [2 /*return*/];
        }
    });
}); };
var validateEnvironment = function () {
    if (!baseUrl) {
        throw new Error('QA_BASE_URL is required for streaming/PDF mixed certification.');
    }
    if (!/\.nip\.io(?:\/|$)/i.test(baseUrl)) {
        throw new Error("QA_BASE_URL must point at the staging/private mirror nip.io host. Got: ".concat(baseUrl));
    }
    if (browserStageCounts.length === 0) {
        throw new Error('QA_STREAM_CERT_BROWSER_STAGES must contain at least one positive stage size.');
    }
    if (syntheticVideoStageCounts.length === 0) {
        throw new Error('QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES must contain at least one positive stage size.');
    }
};
var readPreparedUsers = function (filePath) { return __awaiter(void 0, void 0, void 0, function () {
    var users, _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                _b = (_a = JSON).parse;
                return [4 /*yield*/, promises_1.default.readFile(filePath, 'utf8')];
            case 1:
                users = _b.apply(_a, [_c.sent()]);
                if (!Array.isArray(users) || users.length === 0) {
                    throw new Error("Prepared user manifest is empty: ".concat(filePath));
                }
                return [2 /*return*/, users];
        }
    });
}); };
var buildBaseEnv = function (target) { return (__assign(__assign({}, process.env), { ENV_FILE: envFile, QA_BASE_URL: baseUrl, QA_COURSE_ID: target.courseId, QA_LESSON_ID: target.lessonId, QA_COURSE_TEXT: target.courseText, QA_LESSON_TEXT: target.lessonText, QA_WATCH_LIMIT_COURSE_ID: target.courseId, QA_WATCH_LIMIT_LESSON_ID: target.lessonId, QA_WATCH_LIMIT_COURSE_TEXT: target.courseText, QA_WATCH_LIMIT_LESSON_TEXT: target.lessonText, QA_PDF_ATTACHMENT_ID: target.pdfAttachmentId, QA_PDF_ATTACHMENT_TITLE: target.pdfAttachmentTitle || '', QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS: 'true', QA_VIDEO_BROWSER_SCREENSHOT_SAMPLE: String(screenshotSample), QA_STREAM_CERT_TARGETS_FILE: process.env.QA_STREAM_CERT_TARGETS_FILE || '', QA_STREAM_CERT_TARGET_KEY: target.key })); };
var runCommand = function (label, args, env) { return __awaiter(void 0, void 0, void 0, function () {
    var logPath, child, chunks, exitCode;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                logPath = node_path_1.default.join(reportDir, "".concat(label, ".log"));
                return [4 /*yield*/, ensureDir(node_path_1.default.dirname(logPath))];
            case 1:
                _a.sent();
                child = (0, node_child_process_1.spawn)(args[0], args.slice(1), {
                    cwd: workspaceRoot,
                    env: env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                chunks = [];
                child.stdout.on('data', function (data) { return chunks.push(String(data)); });
                child.stderr.on('data', function (data) { return chunks.push(String(data)); });
                return [4 /*yield*/, new Promise(function (resolve, reject) {
                        child.once('error', reject);
                        child.once('close', function (code) { return resolve(code !== null && code !== void 0 ? code : 1); });
                    })];
            case 2:
                exitCode = _a.sent();
                return [4 /*yield*/, promises_1.default.writeFile(logPath, chunks.join(''), 'utf8')];
            case 3:
                _a.sent();
                if (exitCode !== 0) {
                    throw new Error("".concat(label, " failed with exit code ").concat(exitCode, ". See ").concat(logPath));
                }
                return [2 /*return*/, logPath];
        }
    });
}); };
var runParallelStage = function (label, left, right) { return __awaiter(void 0, void 0, void 0, function () {
    var runOne, logs;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                runOne = function (entry) { return __awaiter(void 0, void 0, void 0, function () {
                    var logPath, child, chunks, exitCode;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                logPath = node_path_1.default.join(reportDir, "".concat(label, "-").concat(entry.logSuffix, ".log"));
                                child = (0, node_child_process_1.spawn)(entry.args[0], entry.args.slice(1), {
                                    cwd: workspaceRoot,
                                    env: entry.env,
                                    stdio: ['ignore', 'pipe', 'pipe'],
                                });
                                chunks = [];
                                child.stdout.on('data', function (data) { return chunks.push(String(data)); });
                                child.stderr.on('data', function (data) { return chunks.push(String(data)); });
                                return [4 /*yield*/, new Promise(function (resolve, reject) {
                                        child.once('error', reject);
                                        child.once('close', function (code) { return resolve(code !== null && code !== void 0 ? code : 1); });
                                    })];
                            case 1:
                                exitCode = _a.sent();
                                return [4 /*yield*/, promises_1.default.writeFile(logPath, chunks.join(''), 'utf8')];
                            case 2:
                                _a.sent();
                                if (exitCode !== 0) {
                                    throw new Error("".concat(label, "/").concat(entry.logSuffix, " failed with exit code ").concat(exitCode, ". See ").concat(logPath));
                                }
                                return [2 /*return*/, logPath];
                        }
                    });
                }); };
                return [4 /*yield*/, Promise.all([runOne(left), runOne(right)])];
            case 1:
                logs = _a.sent();
                return [2 /*return*/, logs];
        }
    });
}); };
var npmRun = function (script) { return ['npm', '--prefix', 'qa-automation', 'run', script]; };
var buildBackgroundLoadEnv = function (target, backgroundManifestPath, userCount) { return ({
    PLATFORM_LOAD_TRAFFIC_MODEL: 'streaming-pdf-mixed',
    PLATFORM_LOAD_USERS: String(userCount),
    PLATFORM_LOAD_ACTIVE_CONCURRENCY: String(userCount),
    PLATFORM_LOAD_USERS_FILE: backgroundManifestPath,
    PLATFORM_LOAD_REUSE_EXISTING_USERS: 'true',
    PLATFORM_LOAD_TOP_UP_EXISTING_USERS: 'false',
    PLATFORM_LOAD_REFRESH_EXISTING_TOKENS: 'false',
    PLATFORM_LOAD_LOGOUT_FRACTION: '0',
    PLATFORM_LOAD_BROWSE_READ_PERCENT: '0',
    PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT: '0',
    PLATFORM_LOAD_LIGHT_WRITE_PERCENT: '0',
    PLATFORM_LOAD_AUTH_SESSION_PERCENT: '40',
    PLATFORM_LOAD_PDF_READ_PERCENT: '40',
    PLATFORM_LOAD_TEST_READ_PERCENT: '20',
    PLATFORM_LOAD_PDF_ATTACHMENT_ID: target.pdfAttachmentId,
    PLATFORM_LOAD_TEST_ID: target.testId,
    PLATFORM_LOAD_COURSE_ID: target.courseId,
    PLATFORM_LOAD_LESSON_ID: target.lessonId,
}); };
var prepareManifest = function (target, cohort, userCount) { return __awaiter(void 0, void 0, void 0, function () {
    var manifestPath, env, logPath;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                manifestPath = node_path_1.default.join(reportDir, "".concat(target.key, "-").concat(cohort, "-users.json"));
                env = __assign(__assign({}, buildBaseEnv(target)), { QA_VIDEO_BROWSER_MANIFEST_USERS: String(userCount), QA_VIDEO_BROWSER_MANIFEST_PATH: manifestPath, QA_VIDEO_BROWSER_USER_PREFIX: "qa.stream.cert.".concat(target.key, ".").concat(cohort, ".") });
                return [4 /*yield*/, runCommand("".concat(target.key, "-").concat(cohort, "-prepare"), npmRun('browser:prepare-video-browser-manifest'), env)];
            case 1:
                logPath = _a.sent();
                return [2 /*return*/, { manifestPath: manifestPath, logPath: logPath }];
        }
    });
}); };
var runTargetMatrix = function (target) { return __awaiter(void 0, void 0, void 0, function () {
    var records, maxBrowserStage, maxSyntheticVideoStage, maxBrowserBackgroundUsers, browserManifest, backgroundManifest, syntheticVideoManifest, browserUsers, loginEmail, baseEnv, runSingleStage, runMixedStage, runSyntheticMixedStage, _i, browserStageCounts_1, stageUsers, _a, syntheticVideoStageCounts_1, stageUsers;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                records = [];
                maxBrowserStage = Math.max.apply(Math, browserStageCounts);
                maxSyntheticVideoStage = Math.max.apply(Math, syntheticVideoStageCounts);
                maxBrowserBackgroundUsers = Math.max(1, Math.round(maxBrowserStage * backgroundRatio));
                return [4 /*yield*/, prepareManifest(target, 'browser', maxBrowserStage)];
            case 1:
                browserManifest = _c.sent();
                return [4 /*yield*/, prepareManifest(target, 'background', Math.max(maxBrowserBackgroundUsers, syntheticBackgroundUsers))];
            case 2:
                backgroundManifest = _c.sent();
                return [4 /*yield*/, prepareManifest(target, 'synthetic-video', maxSyntheticVideoStage)];
            case 3:
                syntheticVideoManifest = _c.sent();
                return [4 /*yield*/, readPreparedUsers(browserManifest.manifestPath)];
            case 4:
                browserUsers = _c.sent();
                loginEmail = ((_b = browserUsers[0]) === null || _b === void 0 ? void 0 : _b.email) || '';
                if (!loginEmail) {
                    throw new Error("No prepared browser user was available for ".concat(target.key, "."));
                }
                baseEnv = buildBaseEnv(target);
                runSingleStage = function (label, script, extraEnv) { return __awaiter(void 0, void 0, void 0, function () {
                    var logPath;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, runCommand("".concat(target.key, "-").concat(label), npmRun(script), __assign(__assign({}, baseEnv), extraEnv))];
                            case 1:
                                logPath = _a.sent();
                                records.push({ label: label, kind: 'single', ok: true, logs: [logPath] });
                                return [2 /*return*/];
                        }
                    });
                }); };
                runMixedStage = function (stageUsers) { return __awaiter(void 0, void 0, void 0, function () {
                    var backgroundStageUsers, logs;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                backgroundStageUsers = Math.max(1, Math.round(stageUsers * backgroundRatio));
                                return [4 /*yield*/, runParallelStage("".concat(target.key, "-mixed-").concat(stageUsers), {
                                        args: npmRun('browser:course-video-browser-concurrency'),
                                        env: __assign(__assign({}, baseEnv), { QA_VIDEO_BROWSER_STAGES: String(stageUsers), QA_VIDEO_BROWSER_STAGE_CONCURRENCY: String(stageUsers), PLATFORM_LOAD_USERS_FILE: browserManifest.manifestPath, COURSE_LOAD_USERS_FILE: browserManifest.manifestPath }),
                                        logSuffix: 'browser',
                                    }, {
                                        args: npmRun('load:platform'),
                                        env: __assign(__assign({}, baseEnv), buildBackgroundLoadEnv(target, backgroundManifest.manifestPath, backgroundStageUsers)),
                                        logSuffix: 'background',
                                    })];
                            case 1:
                                logs = _a.sent();
                                records.push({
                                    label: "mixed-".concat(stageUsers, "-plus-").concat(backgroundStageUsers),
                                    kind: 'parallel',
                                    ok: true,
                                    logs: logs,
                                });
                                return [2 /*return*/];
                        }
                    });
                }); };
                runSyntheticMixedStage = function (stageUsers) { return __awaiter(void 0, void 0, void 0, function () {
                    var logs;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, runParallelStage("".concat(target.key, "-synthetic-").concat(stageUsers), {
                                    args: npmRun('load:course-video'),
                                    env: __assign(__assign({}, baseEnv), { COURSE_LOAD_USERS: String(stageUsers), COURSE_LOAD_ACTIVE_CONCURRENCY: String(stageUsers), COURSE_LOAD_USERS_FILE: syntheticVideoManifest.manifestPath, COURSE_LOAD_REPORT_PREFIX: "".concat(target.key, "-synthetic-video-").concat(stageUsers) }),
                                    logSuffix: 'video',
                                }, {
                                    args: npmRun('load:platform'),
                                    env: __assign(__assign(__assign({}, baseEnv), buildBackgroundLoadEnv(target, backgroundManifest.manifestPath, syntheticBackgroundUsers)), { PLATFORM_LOAD_REPORT_PREFIX: "".concat(target.key, "-synthetic-background-").concat(stageUsers) }),
                                    logSuffix: 'background',
                                })];
                            case 1:
                                logs = _a.sent();
                                records.push({
                                    label: "synthetic-".concat(stageUsers, "-plus-").concat(syntheticBackgroundUsers),
                                    kind: 'parallel',
                                    ok: true,
                                    logs: logs,
                                });
                                return [2 /*return*/];
                        }
                    });
                }); };
                return [4 /*yield*/, runSingleStage('preflight', 'browser:stream-cert-preflight', {
                        QA_STREAM_CERT_PREPARED_USERS_FILE: browserManifest.manifestPath,
                    })];
            case 5:
                _c.sent();
                return [4 /*yield*/, runSingleStage('pdf-smoke', 'browser:course-pdf-editorial', {
                        QA_LOGIN_EMAIL: loginEmail,
                        QA_LOGIN_PASSWORD: userPassword,
                    })];
            case 6:
                _c.sent();
                return [4 /*yield*/, runSingleStage('rootcause-desktop', 'browser:course-playback-rootcause', {
                        QA_LOGIN_EMAIL: loginEmail,
                        QA_LOGIN_PASSWORD: userPassword,
                    })];
            case 7:
                _c.sent();
                return [4 /*yield*/, runSingleStage('rootcause-mobile', 'browser:course-playback-rootcause', {
                        QA_LOGIN_EMAIL: loginEmail,
                        QA_LOGIN_PASSWORD: userPassword,
                        QA_MOBILE_MODE: 'true',
                    })];
            case 8:
                _c.sent();
                return [4 /*yield*/, runSingleStage('watch-limit', 'browser:course-watch-limit-regression', {})];
            case 9:
                _c.sent();
                _i = 0, browserStageCounts_1 = browserStageCounts;
                _c.label = 10;
            case 10:
                if (!(_i < browserStageCounts_1.length)) return [3 /*break*/, 14];
                stageUsers = browserStageCounts_1[_i];
                return [4 /*yield*/, runSingleStage("stream-only-".concat(stageUsers), 'browser:course-video-browser-concurrency', {
                        QA_VIDEO_BROWSER_STAGES: String(stageUsers),
                        QA_VIDEO_BROWSER_STAGE_CONCURRENCY: String(stageUsers),
                        PLATFORM_LOAD_USERS_FILE: browserManifest.manifestPath,
                        COURSE_LOAD_USERS_FILE: browserManifest.manifestPath,
                    })];
            case 11:
                _c.sent();
                return [4 /*yield*/, runMixedStage(stageUsers)];
            case 12:
                _c.sent();
                _c.label = 13;
            case 13:
                _i++;
                return [3 /*break*/, 10];
            case 14:
                _a = 0, syntheticVideoStageCounts_1 = syntheticVideoStageCounts;
                _c.label = 15;
            case 15:
                if (!(_a < syntheticVideoStageCounts_1.length)) return [3 /*break*/, 18];
                stageUsers = syntheticVideoStageCounts_1[_a];
                return [4 /*yield*/, runSyntheticMixedStage(stageUsers)];
            case 16:
                _c.sent();
                _c.label = 17;
            case 17:
                _a++;
                return [3 /*break*/, 15];
            case 18: return [2 /*return*/, records];
        }
    });
}); };
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var allTargets, targets, summary, _i, targets_1, target, records, executedTargetKeys, ranFullMatrix, includesRequiredBrowserStages, includesRequiredSyntheticStages, includesRequiredSyntheticBackground;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                validateEnvironment();
                return [4 /*yield*/, ensureDir(reportDir)];
            case 1:
                _a.sent();
                return [4 /*yield*/, (0, stream_cert_targets_js_1.loadStreamCertTargets)()];
            case 2:
                allTargets = _a.sent();
                targets = (function () {
                    if (requestedTargetKey) {
                        var filtered = allTargets.filter(function (target) { return target.key === requestedTargetKey; });
                        if (!filtered.length) {
                            throw new Error("QA_STREAM_CERT_TARGET_KEY=".concat(requestedTargetKey, " was not found in ").concat(process.env.QA_STREAM_CERT_TARGETS_FILE || 'the target manifest', "."));
                        }
                        return filtered;
                    }
                    if (requestedTargetIndex) {
                        var index = Number(requestedTargetIndex);
                        if (!Number.isFinite(index) || index < 0 || index >= allTargets.length) {
                            throw new Error("QA_STREAM_CERT_TARGET_INDEX=".concat(requestedTargetIndex, " is out of range for ").concat(allTargets.length, " targets."));
                        }
                        return [allTargets[index]];
                    }
                    return allTargets;
                })();
                summary = {
                    ok: true,
                    envFile: envFile,
                    baseUrl: baseUrl,
                    browserStageCounts: browserStageCounts,
                    syntheticVideoStageCounts: syntheticVideoStageCounts,
                    backgroundRatio: backgroundRatio,
                    syntheticBackgroundUsers: syntheticBackgroundUsers,
                    requestedTargetKey: requestedTargetKey || null,
                    requestedTargetIndex: requestedTargetIndex || null,
                    targets: [],
                    reportDir: reportDir,
                };
                _i = 0, targets_1 = targets;
                _a.label = 3;
            case 3:
                if (!(_i < targets_1.length)) return [3 /*break*/, 6];
                target = targets_1[_i];
                return [4 /*yield*/, runTargetMatrix(target)];
            case 4:
                records = _a.sent();
                summary.targets.push({
                    key: target.key,
                    courseId: target.courseId,
                    courseText: target.courseText,
                    lessonId: target.lessonId,
                    lessonText: target.lessonText,
                    pdfAttachmentId: target.pdfAttachmentId,
                    testId: target.testId,
                    records: records,
                });
                _a.label = 5;
            case 5:
                _i++;
                return [3 /*break*/, 3];
            case 6:
                executedTargetKeys = summary.targets.map(function (target) { return String(target.key || ''); });
                ranFullMatrix = !requestedTargetKey && !requestedTargetIndex && executedTargetKeys.length === allTargets.length;
                includesRequiredBrowserStages = [100, 200].every(function (requiredStage) { return browserStageCounts.includes(requiredStage); });
                includesRequiredSyntheticStages = [1000, 2000].every(function (requiredStage) { return syntheticVideoStageCounts.includes(requiredStage); });
                includesRequiredSyntheticBackground = syntheticBackgroundUsers >= 200;
                summary.readyForProductionDeploy = Boolean(summary.ok)
                    && ranFullMatrix
                    && includesRequiredBrowserStages
                    && includesRequiredSyntheticStages
                    && includesRequiredSyntheticBackground;
                summary.executedTargetKeys = executedTargetKeys;
                summary.expectedTargetKeys = allTargets.map(function (target) { return target.key; });
                summary.requiredBrowserStageCounts = [100, 200];
                summary.requiredSyntheticVideoStageCounts = [1000, 2000];
                summary.requiredSyntheticBackgroundUsers = 200;
                summary.deployBlockers = __spreadArray(__spreadArray(__spreadArray(__spreadArray([], (ranFullMatrix ? [] : ['full_target_matrix_not_run']), true), (includesRequiredBrowserStages ? [] : ['required_browser_stages_100_200_missing']), true), (includesRequiredSyntheticStages ? [] : ['required_synthetic_stages_1000_2000_missing']), true), (includesRequiredSyntheticBackground ? [] : ['synthetic_background_users_below_200']), true);
                return [4 /*yield*/, promises_1.default.writeFile(node_path_1.default.join(reportDir, 'streaming-pdf-mixed-certification-summary.json'), JSON.stringify(summary, null, 2), 'utf8')];
            case 7:
                _a.sent();
                return [4 /*yield*/, publishLatestArtifacts(summary)];
            case 8:
                _a.sent();
                console.log(JSON.stringify(summary, null, 2));
                return [2 /*return*/];
        }
    });
}); };
void main().catch(function (error) { return __awaiter(void 0, void 0, void 0, function () {
    var failureSummary;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                failureSummary = {
                    ok: false,
                    readyForProductionDeploy: false,
                    envFile: envFile,
                    baseUrl: baseUrl,
                    browserStageCounts: browserStageCounts,
                    syntheticVideoStageCounts: syntheticVideoStageCounts,
                    backgroundRatio: backgroundRatio,
                    syntheticBackgroundUsers: syntheticBackgroundUsers,
                    reportDir: reportDir,
                    error: error instanceof Error ? error.message : String(error),
                };
                return [4 /*yield*/, ensureDir(reportDir).catch(function () { return undefined; })];
            case 1:
                _a.sent();
                return [4 /*yield*/, promises_1.default.writeFile(node_path_1.default.join(reportDir, 'streaming-pdf-mixed-certification-summary.json'), JSON.stringify(failureSummary, null, 2), 'utf8').catch(function () { return undefined; })];
            case 2:
                _a.sent();
                return [4 /*yield*/, publishLatestArtifacts(failureSummary).catch(function () { return undefined; })];
            case 3:
                _a.sent();
                console.error(error instanceof Error ? error.stack || error.message : String(error));
                process.exitCode = 1;
                return [2 /*return*/];
        }
    });
}); });
