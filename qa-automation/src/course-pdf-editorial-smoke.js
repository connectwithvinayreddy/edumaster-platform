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
Object.defineProperty(exports, "__esModule", { value: true });
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var puppeteer_core_1 = require("puppeteer-core");
var config_js_1 = require("./config.js");
var utils_js_1 = require("./utils.js");
var rootDir = node_path_1.default.resolve(process.cwd(), node_path_1.default.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
var apiOrigin = (function () {
    var url = new URL(config_js_1.config.baseUrl);
    if (url.hostname === '10.0.2.2') {
        url.hostname = '127.0.0.1';
    }
    return url.origin;
})();
var readEnvFile = function () { return __awaiter(void 0, void 0, void 0, function () {
    var values, text, _i, _a, line, trimmed, index, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                values = {};
                _c.label = 1;
            case 1:
                _c.trys.push([1, 3, , 4]);
                return [4 /*yield*/, promises_1.default.readFile(node_path_1.default.join(rootDir, '.env'), 'utf8')];
            case 2:
                text = _c.sent();
                for (_i = 0, _a = text.split(/\r?\n/); _i < _a.length; _i++) {
                    line = _a[_i];
                    trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#'))
                        continue;
                    index = trimmed.indexOf('=');
                    if (index > 0) {
                        values[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
                    }
                }
                return [3 /*break*/, 4];
            case 3:
                _b = _c.sent();
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/, values];
        }
    });
}); };
var login = function (email, password) { return __awaiter(void 0, void 0, void 0, function () {
    var response, payload;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, fetch(new URL('/backend/api/auth/login', apiOrigin), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        email: email,
                        password: password,
                        forceLogoutOtherSessions: true,
                        device: 'QA PDF Editorial Smoke',
                    }),
                })];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json().catch(function () { return ({}); })];
            case 2:
                payload = _a.sent();
                if (!response.ok || !(payload === null || payload === void 0 ? void 0 : payload.token)) {
                    throw new Error((payload === null || payload === void 0 ? void 0 : payload.message) || "Unable to login for PDF/editorial smoke: ".concat(response.status));
                }
                return [2 /*return*/, String(payload.token)];
        }
    });
}); };
var apiGet = function (pathname, token) { return __awaiter(void 0, void 0, void 0, function () {
    var response, payload;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, fetch(new URL(pathname, apiOrigin), {
                    headers: { authorization: "Bearer ".concat(token) },
                })];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json().catch(function () { return ({}); })];
            case 2:
                payload = _a.sent();
                if (!response.ok) {
                    throw new Error((payload === null || payload === void 0 ? void 0 : payload.message) || "GET ".concat(pathname, " failed: ").concat(response.status));
                }
                return [2 /*return*/, payload];
        }
    });
}); };
var requestJson = function (pathname, token) { return __awaiter(void 0, void 0, void 0, function () {
    var response, payload;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, fetch(new URL(pathname, apiOrigin), {
                    headers: { authorization: "Bearer ".concat(token) },
                })];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json().catch(function () { return ({}); })];
            case 2:
                payload = _a.sent();
                return [2 /*return*/, { status: response.status, ok: response.ok, payload: payload }];
        }
    });
}); };
var findLessonWithPdf = function (course) {
    for (var _i = 0, _a = course.modules || []; _i < _a.length; _i++) {
        var module_1 = _a[_i];
        for (var _b = 0, _c = module_1.lessons || []; _b < _c.length; _b++) {
            var lesson = _c[_b];
            if ((lesson.attachments || []).length > 0 || lesson.notesUrl) {
                return lesson;
            }
        }
        for (var _d = 0, _e = module_1.chapters || []; _d < _e.length; _d++) {
            var chapter = _e[_d];
            for (var _f = 0, _g = chapter.lessons || []; _f < _g.length; _f++) {
                var lesson = _g[_f];
                if ((lesson.attachments || []).length > 0 || lesson.notesUrl) {
                    return lesson;
                }
            }
        }
    }
    return null;
};
var findPdfTarget = function (course) {
    for (var _i = 0, _a = course.modules || []; _i < _a.length; _i++) {
        var module_2 = _a[_i];
        for (var _b = 0, _c = module_2.lessons || []; _b < _c.length; _b++) {
            var lesson = _c[_b];
            var attachment = (lesson.attachments || [])[0];
            if (attachment === null || attachment === void 0 ? void 0 : attachment.id) {
                return { attachmentId: attachment.id, title: lesson.title, source: 'lesson' };
            }
        }
        for (var _d = 0, _e = module_2.chapters || []; _d < _e.length; _d++) {
            var chapter = _e[_d];
            var chapterAttachment = (chapter.attachments || [])[0];
            if (chapterAttachment === null || chapterAttachment === void 0 ? void 0 : chapterAttachment.id) {
                return { attachmentId: chapterAttachment.id, title: chapter.title, source: 'chapter' };
            }
            for (var _f = 0, _g = chapter.lessons || []; _f < _g.length; _f++) {
                var lesson = _g[_f];
                var lessonAttachment = (lesson.attachments || [])[0];
                if (lessonAttachment === null || lessonAttachment === void 0 ? void 0 : lessonAttachment.id) {
                    return { attachmentId: lessonAttachment.id, title: lesson.title, source: 'lesson' };
                }
            }
        }
    }
    return null;
};
var findPdfTargetById = function (course, attachmentId) {
    var expectedAttachmentId = String(attachmentId || '').trim();
    if (!expectedAttachmentId) {
        return null;
    }
    for (var _i = 0, _a = course.modules || []; _i < _a.length; _i++) {
        var module_3 = _a[_i];
        for (var _b = 0, _c = module_3.lessons || []; _b < _c.length; _b++) {
            var lesson = _c[_b];
            var attachment = (lesson.attachments || []).find(function (entry) { return entry.id === expectedAttachmentId; });
            if (attachment === null || attachment === void 0 ? void 0 : attachment.id) {
                return {
                    attachmentId: attachment.id,
                    title: attachment.title || lesson.title,
                    source: 'lesson',
                };
            }
        }
        for (var _d = 0, _e = module_3.chapters || []; _d < _e.length; _d++) {
            var chapter = _e[_d];
            var chapterAttachment = ((chapter.attachments) || [])
                .find(function (entry) { return entry.id === expectedAttachmentId; });
            if (chapterAttachment === null || chapterAttachment === void 0 ? void 0 : chapterAttachment.id) {
                return {
                    attachmentId: chapterAttachment.id,
                    title: chapterAttachment.title || chapter.title,
                    source: 'chapter',
                };
            }
            for (var _f = 0, _g = chapter.lessons || []; _f < _g.length; _f++) {
                var lesson = _g[_f];
                var lessonAttachment = (lesson.attachments || []).find(function (entry) { return entry.id === expectedAttachmentId; });
                if (lessonAttachment === null || lessonAttachment === void 0 ? void 0 : lessonAttachment.id) {
                    return {
                        attachmentId: lessonAttachment.id,
                        title: lessonAttachment.title || lesson.title,
                        source: 'lesson',
                    };
                }
            }
        }
    }
    return null;
};
var findSectionWithPdf = function (course) {
    for (var _i = 0, _a = course.modules || []; _i < _a.length; _i++) {
        var module_4 = _a[_i];
        for (var _b = 0, _c = module_4.chapters || []; _b < _c.length; _b++) {
            var chapter = _c[_b];
            var attachments = chapter.attachments || [];
            if (attachments.length > 0) {
                return { id: chapter.id, title: chapter.title, attachmentCount: attachments.length };
            }
        }
    }
    return null;
};
var findAttachmentInCourse = function (course, attachmentId) {
    if (!course) {
        return null;
    }
    for (var _i = 0, _a = course.modules || []; _i < _a.length; _i++) {
        var module_5 = _a[_i];
        for (var _b = 0, _c = module_5.attachments || []; _b < _c.length; _b++) {
            var attachment = _c[_b];
            if (attachment.id === attachmentId) {
                return { scope: 'module', title: attachment.title || module_5.title || 'Module PDF' };
            }
        }
        for (var _d = 0, _e = module_5.lessons || []; _d < _e.length; _d++) {
            var lesson = _e[_d];
            for (var _f = 0, _g = lesson.attachments || []; _f < _g.length; _f++) {
                var attachment = _g[_f];
                if (attachment.id === attachmentId) {
                    return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
                }
            }
        }
        for (var _h = 0, _j = module_5.chapters || []; _h < _j.length; _h++) {
            var chapter = _j[_h];
            for (var _k = 0, _l = (chapter.attachments || []); _k < _l.length; _k++) {
                var attachment = _l[_k];
                if (attachment.id === attachmentId) {
                    return { scope: 'chapter', title: attachment.title || chapter.title || 'Chapter PDF' };
                }
            }
            for (var _m = 0, _o = chapter.lessons || []; _m < _o.length; _m++) {
                var lesson = _o[_m];
                for (var _p = 0, _q = lesson.attachments || []; _p < _q.length; _p++) {
                    var attachment = _q[_p];
                    if (attachment.id === attachmentId) {
                        return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
                    }
                }
            }
        }
    }
    return null;
};
var screenshot = function (page, root, label) { return __awaiter(void 0, void 0, void 0, function () {
    var screenshotPath;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                screenshotPath = (0, utils_js_1.artifactPath)(root, 'course-pdf-editorial', label, 'png');
                return [4 /*yield*/, page.screenshot({ path: screenshotPath, fullPage: true })];
            case 1:
                _a.sent();
                return [2 /*return*/, screenshotPath];
        }
    });
}); };
var validatePdfRange = function (courseId, attachmentId, token) { return __awaiter(void 0, void 0, void 0, function () {
    var url, first, firstBytes, second;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                url = new URL("/backend/api/courses/".concat(courseId, "/pdf-attachments/").concat(attachmentId, "/view"), apiOrigin);
                return [4 /*yield*/, fetch(url, {
                        headers: {
                            authorization: "Bearer ".concat(token),
                            range: 'bytes=0-65535',
                            'x-edumaster-client-platform': 'web',
                            'x-edumaster-client-browser': 'chrome',
                            'x-edumaster-app': 'web',
                        },
                    })];
            case 1:
                first = _a.sent();
                return [4 /*yield*/, first.arrayBuffer()];
            case 2:
                firstBytes = _a.sent();
                if (first.status !== 206) {
                    throw new Error("Expected first PDF range to return 206, got ".concat(first.status));
                }
                if (!/^bytes 0-\d+\/\d+$/.test(first.headers.get('content-range') || '')) {
                    throw new Error("First PDF range returned invalid Content-Range: ".concat(first.headers.get('content-range') || '(missing)'));
                }
                if ((first.headers.get('accept-ranges') || '').toLowerCase() !== 'bytes') {
                    throw new Error('First PDF range did not advertise Accept-Ranges: bytes.');
                }
                if (firstBytes.byteLength <= 0 || firstBytes.byteLength > 65536) {
                    throw new Error("First PDF range returned unexpected byte length: ".concat(firstBytes.byteLength));
                }
                return [4 /*yield*/, fetch(url, {
                        headers: {
                            authorization: "Bearer ".concat(token),
                            range: 'bytes=65536-131071',
                            'x-edumaster-client-platform': 'web',
                            'x-edumaster-client-browser': 'chrome',
                            'x-edumaster-app': 'web',
                        },
                    })];
            case 3:
                second = _a.sent();
                if (![206, 416].includes(second.status)) {
                    throw new Error("Expected follow-up PDF range to return 206 or 416 for tiny PDFs, got ".concat(second.status));
                }
                return [2 /*return*/, {
                        firstStatus: first.status,
                        firstContentRange: first.headers.get('content-range'),
                        firstBytes: firstBytes.byteLength,
                        secondStatus: second.status,
                        secondContentRange: second.headers.get('content-range'),
                    }];
        }
    });
}); };
var diagnoseUserVisibility = function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var token, courseResponse, attachmentLocation, pdfProbe, buffer;
    var _c, _d, _e;
    var label = _b.label, email = _b.email, password = _b.password, courseId = _b.courseId, attachmentId = _b.attachmentId;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, login(email, password)];
            case 1:
                token = _f.sent();
                return [4 /*yield*/, requestJson("/backend/api/courses/".concat(encodeURIComponent(courseId)), token)];
            case 2:
                courseResponse = _f.sent();
                attachmentLocation = courseResponse.ok ? findAttachmentInCourse(courseResponse.payload, attachmentId) : null;
                return [4 /*yield*/, fetch(new URL("/backend/api/courses/".concat(encodeURIComponent(courseId), "/pdf-attachments/").concat(encodeURIComponent(attachmentId), "/view"), apiOrigin), {
                        headers: {
                            authorization: "Bearer ".concat(token),
                            accept: 'application/pdf',
                            range: 'bytes=0-65535',
                            'x-edumaster-app': 'web',
                            'x-edumaster-client-platform': 'windows',
                            'x-edumaster-client-browser': 'chrome',
                            'x-edumaster-device-id': "pdf-diag-".concat(label),
                            'x-edumaster-playback-tab-id': "pdf-diag-tab-".concat(label),
                            'x-edumaster-browser-tab-id': "pdf-diag-tab-".concat(label),
                        },
                    })];
            case 3:
                pdfProbe = _f.sent();
                return [4 /*yield*/, pdfProbe.arrayBuffer()];
            case 4:
                buffer = _f.sent();
                return [2 /*return*/, {
                        label: label,
                        email: email,
                        courseStatus: courseResponse.status,
                        attachmentVisibleInCourse: Boolean(attachmentLocation),
                        attachmentLocation: attachmentLocation,
                        enrolled: typeof ((_c = courseResponse.payload) === null || _c === void 0 ? void 0 : _c.enrolled) === 'boolean' ? courseResponse.payload.enrolled : null,
                        canAccessCourse: typeof ((_d = courseResponse.payload) === null || _d === void 0 ? void 0 : _d.canAccessCourse) === 'boolean' ? courseResponse.payload.canAccessCourse : null,
                        accessReason: ((_e = courseResponse.payload) === null || _e === void 0 ? void 0 : _e.accessReason) || null,
                        pdfStatus: pdfProbe.status,
                        pdfOk: pdfProbe.ok || pdfProbe.status === 206,
                        pdfContentType: pdfProbe.headers.get('content-type') || '',
                        pdfContentRange: pdfProbe.headers.get('content-range'),
                        pdfBytesRead: buffer.byteLength,
                    }];
        }
    });
}); };
var openAndAssertPdfReader = function (page, root, label) { return __awaiter(void 0, void 0, void 0, function () {
    var state, screenshotPath;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, page.waitForSelector('[data-testid="course-pdf-open-button"]', { timeout: 15000 })];
            case 1:
                _a.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var button = document.querySelector('[data-testid="course-pdf-open-button"]');
                        button === null || button === void 0 ? void 0 : button.click();
                    })];
            case 2:
                _a.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-pdf-page"] canvas', { timeout: 45000 })];
            case 3:
                _a.sent();
                return [4 /*yield*/, page.waitForFunction(function () {
                        var counter = document.querySelector('[data-testid="course-pdf-page-count"]');
                        return /Page\s+\d+\s+\/\s+\d+/.test((counter === null || counter === void 0 ? void 0 : counter.textContent) || '');
                    }, { timeout: 45000 })];
            case 4:
                _a.sent();
                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1200); })];
            case 5:
                _a.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var _a;
                        var scroll = document.querySelector('[data-testid="course-pdf-scroll-container"]');
                        var pages = Array.from(document.querySelectorAll('[data-testid="course-pdf-page"]'));
                        var canvases = Array.from(document.querySelectorAll('[data-testid="course-pdf-page"] canvas'));
                        var pageCountText = ((_a = document.querySelector('[data-testid="course-pdf-page-count"]')) === null || _a === void 0 ? void 0 : _a.textContent) || '';
                        var pageCountMatch = pageCountText.match(/\/\s*(\d+)/);
                        var declaredPageCount = pageCountMatch ? Number(pageCountMatch[1]) : 0;
                        var maxCanvasWidth = canvases.reduce(function (max, canvas) { return Math.max(max, canvas.getBoundingClientRect().width); }, 0);
                        var scrollWidth = (scroll === null || scroll === void 0 ? void 0 : scroll.scrollWidth) || 0;
                        var clientWidth = (scroll === null || scroll === void 0 ? void 0 : scroll.clientWidth) || 0;
                        return {
                            pageCountText: pageCountText,
                            declaredPageCount: declaredPageCount,
                            renderedPageCount: pages.length,
                            scrollHeight: (scroll === null || scroll === void 0 ? void 0 : scroll.scrollHeight) || 0,
                            clientHeight: (scroll === null || scroll === void 0 ? void 0 : scroll.clientHeight) || 0,
                            scrollWidth: scrollWidth,
                            clientWidth: clientWidth,
                            maxCanvasWidth: maxCanvasWidth,
                            horizontalOverflow: scrollWidth > clientWidth + 4 || maxCanvasWidth > clientWidth + 4,
                        };
                    })];
            case 6:
                state = _a.sent();
                if (state.declaredPageCount <= 1 || state.renderedPageCount <= 1) {
                    throw new Error("Expected multi-page PDF render, got ".concat(JSON.stringify(state)));
                }
                if (state.scrollHeight <= state.clientHeight) {
                    throw new Error("Expected PDF reader to scroll vertically, got ".concat(JSON.stringify(state)));
                }
                if (state.horizontalOverflow) {
                    throw new Error("Expected PDF reader to fit width without clipping, got ".concat(JSON.stringify(state)));
                }
                return [4 /*yield*/, screenshot(page, root, label)];
            case 7:
                screenshotPath = _a.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var close = Array.from(document.querySelectorAll('button')).find(function (button) { return /close/i.test(button.textContent || ''); });
                        close === null || close === void 0 ? void 0 : close.click();
                    })];
            case 8:
                _a.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-pdf-scroll-container"]', { hidden: true, timeout: 15000 }).catch(function () { return undefined; })];
            case 9:
                _a.sent();
                return [2 /*return*/, __assign(__assign({}, state), { screenshotPath: screenshotPath })];
        }
    });
}); };
var main = function () { return __awaiter(void 0, void 0, void 0, function () {
    var env, email, password, token, expectedCourseId, expectedCourseText, expectedPdfAttachmentId, expectedPdfAttachmentTitle, course, _a, courses, _b, selectedCourse, lessonWithPdf, sectionWithPdf, pdfTarget, normalizedResolvedTitle, normalizedExpectedTitle, rangeState, _c, crossUserDiagnosis, _d, ctx, browser, page, desktopPath, desktopState, desktopPdfReaderState, _e, desktopEditorialPath, editorialState, mobileContentPath, mobileContentState, mobilePdfReaderState, _f, mobileEditorialPath, mobileEditorialState, summary;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, readEnvFile()];
            case 1:
                env = _g.sent();
                email = process.env.QA_ADMIN_EMAIL || process.env.QA_LOGIN_EMAIL || env.ADMIN_EMAIL || '';
                password = process.env.QA_ADMIN_PASSWORD || process.env.QA_LOGIN_PASSWORD || env.ADMIN_PASSWORD || '';
                if (!email || !password) {
                    throw new Error('QA_ADMIN_EMAIL/QA_ADMIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD is required.');
                }
                return [4 /*yield*/, login(email, password)];
            case 2:
                token = _g.sent();
                expectedCourseId = String(process.env.QA_COURSE_ID || '').trim();
                expectedCourseText = String(process.env.QA_COURSE_TEXT || '').toLowerCase();
                expectedPdfAttachmentId = String(process.env.QA_PDF_ATTACHMENT_ID || '').trim();
                expectedPdfAttachmentTitle = String(process.env.QA_PDF_ATTACHMENT_TITLE || '').trim();
                if (!expectedCourseId) return [3 /*break*/, 4];
                return [4 /*yield*/, apiGet("/backend/api/courses/".concat(encodeURIComponent(expectedCourseId)), token)];
            case 3:
                _a = _g.sent();
                return [3 /*break*/, 5];
            case 4:
                _a = null;
                _g.label = 5;
            case 5:
                course = _a;
                if (!expectedCourseId) return [3 /*break*/, 6];
                _b = [course];
                return [3 /*break*/, 8];
            case 6: return [4 /*yield*/, apiGet('/backend/api/courses/admin/list', token)];
            case 7:
                _b = _g.sent();
                _g.label = 8;
            case 8:
                courses = _b;
                selectedCourse = expectedCourseId
                    ? course
                    : courses.find(function (entry) { return expectedCourseId && entry._id === expectedCourseId; })
                        || courses.find(function (entry) { return expectedCourseText && entry.title.toLowerCase().includes(expectedCourseText); })
                        || courses.find(function (entry) { return expectedPdfAttachmentId && Boolean(findPdfTargetById(entry, expectedPdfAttachmentId)); })
                        || courses.find(function (entry) { return findLessonWithPdf(entry) || findSectionWithPdf(entry); })
                        || courses[0];
                if (!selectedCourse) {
                    throw new Error('No course is available for PDF/editorial smoke.');
                }
                lessonWithPdf = findLessonWithPdf(selectedCourse);
                sectionWithPdf = findSectionWithPdf(selectedCourse);
                pdfTarget = expectedPdfAttachmentId
                    ? findPdfTargetById(selectedCourse, expectedPdfAttachmentId)
                    : findPdfTarget(selectedCourse);
                if ((expectedCourseId || expectedCourseText || expectedPdfAttachmentId) && !pdfTarget) {
                    throw new Error("Selected course ".concat(selectedCourse.title, " does not expose the expected PDF attachment for the current user."));
                }
                if (pdfTarget && expectedPdfAttachmentTitle) {
                    normalizedResolvedTitle = String(pdfTarget.title || '').trim().toLowerCase();
                    normalizedExpectedTitle = expectedPdfAttachmentTitle.toLowerCase();
                    if (normalizedResolvedTitle && normalizedResolvedTitle !== normalizedExpectedTitle) {
                        throw new Error("Expected PDF title \"".concat(expectedPdfAttachmentTitle, "\" but resolved \"").concat(pdfTarget.title, "\"."));
                    }
                }
                if (!pdfTarget) return [3 /*break*/, 10];
                return [4 /*yield*/, validatePdfRange(selectedCourse._id, pdfTarget.attachmentId, token)];
            case 9:
                _c = _g.sent();
                return [3 /*break*/, 11];
            case 10:
                _c = null;
                _g.label = 11;
            case 11:
                rangeState = _c;
                if (!pdfTarget) return [3 /*break*/, 13];
                return [4 /*yield*/, Promise.all([
                        { label: 'admin', email: email, password: password },
                        {
                            label: 'student_working',
                            email: process.env.QA_STUDENT_WORKING_EMAIL || '',
                            password: process.env.QA_STUDENT_WORKING_PASSWORD || '',
                        },
                        {
                            label: 'student_affected',
                            email: process.env.QA_STUDENT_AFFECTED_EMAIL || '',
                            password: process.env.QA_STUDENT_AFFECTED_PASSWORD || '',
                        },
                    ]
                        .filter(function (entry) { return entry.email && entry.password; })
                        .map(function (entry) { return diagnoseUserVisibility(__assign(__assign({}, entry), { courseId: selectedCourse._id, attachmentId: pdfTarget.attachmentId })); }))];
            case 12:
                _d = _g.sent();
                return [3 /*break*/, 14];
            case 13:
                _d = [];
                _g.label = 14;
            case 14:
                crossUserDiagnosis = _d;
                return [4 /*yield*/, (0, utils_js_1.createRunContext)()];
            case 15:
                ctx = _g.sent();
                return [4 /*yield*/, puppeteer_core_1.default.launch({
                        executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                        headless: true,
                        args: ['--no-sandbox', '--disable-dev-shm-usage'],
                    })];
            case 16:
                browser = _g.sent();
                _g.label = 17;
            case 17:
                _g.trys.push([17, , 50, 52]);
                return [4 /*yield*/, browser.newPage()];
            case 18:
                page = _g.sent();
                return [4 /*yield*/, page.evaluateOnNewDocument(function (jwt) {
                        window.localStorage.setItem('edumaster.jwt', jwt);
                    }, token)];
            case 19:
                _g.sent();
                return [4 /*yield*/, page.setViewport({ width: 1536, height: 1024, deviceScaleFactor: 1 })];
            case 20:
                _g.sent();
                return [4 /*yield*/, page.goto("".concat(config_js_1.config.baseUrl.replace(/\/$/, ''), "/?tab=courses&courseId=").concat(encodeURIComponent(selectedCourse._id)), {
                        waitUntil: 'domcontentloaded',
                        timeout: 45000,
                    })];
            case 21:
                _g.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-figma-page"]', { timeout: 45000 })];
            case 22:
                _g.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-figma-tabs"] button', { timeout: 15000 })];
            case 23:
                _g.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var toggles = Array.from(document.querySelectorAll('[data-testid^="course-figma-chapter-"][data-testid$="-toggle"]'));
                        toggles.filter(function (toggle) { return toggle.getAttribute('aria-expanded') !== 'true'; }).forEach(function (toggle) { return toggle.click(); });
                    })];
            case 24:
                _g.sent();
                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 500); })];
            case 25:
                _g.sent();
                return [4 /*yield*/, screenshot(page, ctx.screenshotDir, 'desktop-lessons')];
            case 26:
                desktopPath = _g.sent();
                return [4 /*yield*/, page.evaluate(function (lessonTitle) {
                        var text = document.body.textContent || '';
                        var tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button'))
                            .map(function (button) { return (button.textContent || '').trim(); });
                        var lessonCards = Array.from(document.querySelectorAll('[data-testid="lesson-pdf-list"]'));
                        var lessonPdfTexts = lessonCards.map(function (card) { return card.textContent || ''; });
                        return {
                            tabs: tabs,
                            hasLessonsTab: tabs.some(function (tab) { return /^lessons$/i.test(tab); }),
                            hasEditorialTab: tabs.some(function (tab) { return /^editorial$/i.test(tab); }),
                            hasCourseWideUploadedPdfPanel: /Uploaded PDFs/i.test(text),
                            pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
                            lessonPdfListCount: lessonCards.length,
                            lessonPdfUnderExpectedLesson: lessonTitle
                                ? lessonPdfTexts.some(function (entry) { return entry.toLowerCase().includes(String(lessonTitle).toLowerCase()) || /lesson pdf/i.test(entry); })
                                : lessonCards.length > 0,
                        };
                    }, (lessonWithPdf === null || lessonWithPdf === void 0 ? void 0 : lessonWithPdf.title) || '')];
            case 27:
                desktopState = _g.sent();
                if (!desktopState.hasLessonsTab || !desktopState.hasEditorialTab) {
                    throw new Error("Desktop course tabs are wrong: ".concat(desktopState.tabs.join(', ') || '(none)'));
                }
                if (desktopState.hasCourseWideUploadedPdfPanel) {
                    throw new Error('Desktop course page still shows a broad Uploaded PDFs panel.');
                }
                if ((lessonWithPdf || sectionWithPdf) && desktopState.lessonPdfListCount <= 0) {
                    throw new Error("PDF for ".concat((lessonWithPdf === null || lessonWithPdf === void 0 ? void 0 : lessonWithPdf.title) || (sectionWithPdf === null || sectionWithPdf === void 0 ? void 0 : sectionWithPdf.title), " is not rendered inline under the lesson/chapter."));
                }
                if (!(desktopState.pdfButtonCount > 0)) return [3 /*break*/, 29];
                return [4 /*yield*/, openAndAssertPdfReader(page, ctx.screenshotDir, 'desktop-pdf-reader')];
            case 28:
                _e = _g.sent();
                return [3 /*break*/, 30];
            case 29:
                _e = null;
                _g.label = 30;
            case 30:
                desktopPdfReaderState = _e;
                return [4 /*yield*/, page.evaluate(function () {
                        var _a;
                        var tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button'));
                        (_a = tabs.find(function (tab) { return /editorial/i.test(tab.textContent || ''); })) === null || _a === void 0 ? void 0 : _a.click();
                    })];
            case 31:
                _g.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-editorial-tab"]', { timeout: 15000 })];
            case 32:
                _g.sent();
                return [4 /*yield*/, screenshot(page, ctx.screenshotDir, 'desktop-editorial')];
            case 33:
                desktopEditorialPath = _g.sent();
                return [4 /*yield*/, page.evaluate(function () { return ({
                        text: document.body.textContent || '',
                        pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
                        editorialOpenButtonCount: document.querySelectorAll('[data-testid="course-editorial-open-button"]').length,
                    }); })];
            case 34:
                editorialState = _g.sent();
                if (/Uploaded PDFs/i.test(editorialState.text) || editorialState.pdfButtonCount > 0) {
                    throw new Error('Editorial tab still contains PDF resources; it must contain editorial videos only.');
                }
                return [4 /*yield*/, page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })];
            case 35:
                _g.sent();
                return [4 /*yield*/, page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })];
            case 36:
                _g.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-figma-page"]', { timeout: 45000 })];
            case 37:
                _g.sent();
                return [4 /*yield*/, page.evaluate(function () {
                        var toggles = Array.from(document.querySelectorAll('[data-testid^="course-figma-chapter-"][data-testid$="-toggle"]'));
                        toggles.filter(function (toggle) { return toggle.getAttribute('aria-expanded') !== 'true'; }).forEach(function (toggle) { return toggle.click(); });
                    })];
            case 38:
                _g.sent();
                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 500); })];
            case 39:
                _g.sent();
                return [4 /*yield*/, screenshot(page, ctx.screenshotDir, 'mobile-content')];
            case 40:
                mobileContentPath = _g.sent();
                return [4 /*yield*/, page.evaluate(function () { return ({
                        pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
                    }); })];
            case 41:
                mobileContentState = _g.sent();
                if (!(mobileContentState.pdfButtonCount > 0)) return [3 /*break*/, 43];
                return [4 /*yield*/, openAndAssertPdfReader(page, ctx.screenshotDir, 'mobile-pdf-reader')];
            case 42:
                _f = _g.sent();
                return [3 /*break*/, 44];
            case 43:
                _f = null;
                _g.label = 44;
            case 44:
                mobilePdfReaderState = _f;
                return [4 /*yield*/, page.evaluate(function () {
                        var _a;
                        var tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button'));
                        (_a = tabs.find(function (tab) { return /editorial/i.test(tab.textContent || ''); })) === null || _a === void 0 ? void 0 : _a.click();
                    })];
            case 45:
                _g.sent();
                return [4 /*yield*/, page.waitForSelector('[data-testid="course-editorial-tab"]', { timeout: 15000 })];
            case 46:
                _g.sent();
                return [4 /*yield*/, screenshot(page, ctx.screenshotDir, 'mobile-editorial')];
            case 47:
                mobileEditorialPath = _g.sent();
                return [4 /*yield*/, page.evaluate(function () { return ({
                        text: document.body.textContent || '',
                        pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
                        uploadInputCount: document.querySelectorAll('[data-testid="lesson-doubt-file-input"], [data-testid="lesson-report-file-input"]').length,
                    }); })];
            case 48:
                mobileEditorialState = _g.sent();
                if (/Uploaded PDFs/i.test(mobileEditorialState.text) || mobileEditorialState.pdfButtonCount > 0) {
                    throw new Error('Mobile Editorial tab still contains PDF resources.');
                }
                if (mobileEditorialState.uploadInputCount > 0) {
                    throw new Error('Removed student support upload inputs are still visible.');
                }
                summary = {
                    ok: true,
                    course: { id: selectedCourse._id, title: selectedCourse.title },
                    lessonWithPdf: lessonWithPdf ? { id: lessonWithPdf.id, title: lessonWithPdf.title } : null,
                    sectionWithPdf: sectionWithPdf,
                    pdfTarget: pdfTarget,
                    rangeState: rangeState,
                    crossUserDiagnosis: crossUserDiagnosis,
                    desktopState: desktopState,
                    desktopPdfReaderState: desktopPdfReaderState,
                    mobileContentState: mobileContentState,
                    mobilePdfReaderState: mobilePdfReaderState,
                    editorialState: editorialState,
                    mobileEditorialState: mobileEditorialState,
                    screenshots: {
                        desktopLessons: desktopPath,
                        desktopEditorial: desktopEditorialPath,
                        mobileContent: mobileContentPath,
                        mobileEditorial: mobileEditorialPath,
                    },
                };
                return [4 /*yield*/, (0, utils_js_1.writeJson)(node_path_1.default.join(ctx.analysisDir, 'course-pdf-editorial-smoke.json'), summary)];
            case 49:
                _g.sent();
                console.log(JSON.stringify(summary, null, 2));
                return [3 /*break*/, 52];
            case 50: return [4 /*yield*/, browser.close().catch(function () { return undefined; })];
            case 51:
                _g.sent();
                return [7 /*endfinally*/];
            case 52: return [2 /*return*/];
        }
    });
}); };
main().catch(function (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
