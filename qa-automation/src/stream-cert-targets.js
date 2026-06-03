"use strict";
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
exports.getStreamCertTargetSelection = exports.loadStreamCertTargets = exports.resolveStreamCertTargetsPath = void 0;
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var recorded_delivery_path_js_1 = require("./recorded-delivery-path.js");
var workspaceRoot = node_path_1.default.resolve(process.cwd(), node_path_1.default.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
var normalizeKey = function (value) { return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''); };
var requireNonEmptyString = function (value, field) {
    var normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error("Missing required stream certification target field: ".concat(field));
    }
    return normalized;
};
var normalizeExpectedDeliveryPath = function (value) {
    var normalized = (0, recorded_delivery_path_js_1.normalizeRecordedDeliveryPath)(value);
    return normalized || 'protected_hls_gateway';
};
var normalizeTarget = function (value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error("Stream certification target at index ".concat(index, " must be an object."));
    }
    var raw = value;
    var courseText = requireNonEmptyString(raw.courseText, "targets[".concat(index, "].courseText"));
    var lessonText = requireNonEmptyString(raw.lessonText, "targets[".concat(index, "].lessonText"));
    var key = normalizeKey(String(raw.key || raw.name || "".concat(courseText, "-").concat(lessonText)));
    return {
        key: key || "target-".concat(index + 1),
        courseId: requireNonEmptyString(raw.courseId, "targets[".concat(index, "].courseId")),
        courseText: courseText,
        lessonId: requireNonEmptyString(raw.lessonId, "targets[".concat(index, "].lessonId")),
        lessonText: lessonText,
        pdfAttachmentId: requireNonEmptyString(raw.pdfAttachmentId, "targets[".concat(index, "].pdfAttachmentId")),
        pdfAttachmentTitle: String(raw.pdfAttachmentTitle || '').trim() || null,
        testId: requireNonEmptyString(raw.testId, "targets[".concat(index, "].testId")),
        testTitle: String(raw.testTitle || '').trim() || null,
        expectedDeliveryPath: normalizeExpectedDeliveryPath(raw.expectedDeliveryPath),
    };
};
var resolveStreamCertTargetsPath = function () {
    var requested = String(process.env.QA_STREAM_CERT_TARGETS_FILE || '').trim();
    if (!requested) {
        return '';
    }
    return node_path_1.default.isAbsolute(requested) ? requested : node_path_1.default.resolve(workspaceRoot, requested);
};
exports.resolveStreamCertTargetsPath = resolveStreamCertTargetsPath;
var loadStreamCertTargets = function () { return __awaiter(void 0, void 0, void 0, function () {
    var filePath, raw, _a, _b, targets;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                filePath = (0, exports.resolveStreamCertTargetsPath)();
                if (!filePath) {
                    throw new Error('QA_STREAM_CERT_TARGETS_FILE is required.');
                }
                _b = (_a = JSON).parse;
                return [4 /*yield*/, promises_1.default.readFile(filePath, 'utf8')];
            case 1:
                raw = _b.apply(_a, [_c.sent()]);
                if (!Array.isArray(raw)) {
                    throw new Error("Expected ".concat(filePath, " to contain a JSON array of stream certification targets."));
                }
                targets = raw.map(function (entry, index) { return normalizeTarget(entry, index); });
                if (targets.length === 0) {
                    throw new Error("No stream certification targets were found in ".concat(filePath, "."));
                }
                return [2 /*return*/, targets];
        }
    });
}); };
exports.loadStreamCertTargets = loadStreamCertTargets;
var getStreamCertTargetSelection = function () { return __awaiter(void 0, void 0, void 0, function () {
    var targets, requestedIndex, requestedKey, index, parsed;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, exports.loadStreamCertTargets)()];
            case 1:
                targets = _a.sent();
                requestedIndex = String(process.env.QA_STREAM_CERT_TARGET_INDEX || '').trim();
                requestedKey = normalizeKey(String(process.env.QA_STREAM_CERT_TARGET_KEY || '').trim());
                index = 0;
                if (requestedKey) {
                    index = targets.findIndex(function (target) { return target.key === requestedKey; });
                    if (index === -1) {
                        throw new Error("QA_STREAM_CERT_TARGET_KEY=".concat(requestedKey, " was not found in ").concat((0, exports.resolveStreamCertTargetsPath)(), "."));
                    }
                }
                else if (requestedIndex) {
                    parsed = Number(requestedIndex);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= targets.length) {
                        throw new Error("QA_STREAM_CERT_TARGET_INDEX=".concat(requestedIndex, " is out of range for ").concat(targets.length, " targets."));
                    }
                    index = parsed;
                }
                return [2 /*return*/, {
                        targets: targets,
                        index: index,
                        target: targets[index],
                    }];
        }
    });
}); };
exports.getStreamCertTargetSelection = getStreamCertTargetSelection;
