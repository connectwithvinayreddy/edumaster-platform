"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeliveryPathBreakdown = exports.classifyRecordedDeliveryPath = exports.normalizeRecordedDeliveryPath = void 0;
var normalize = function (value) { return String(value || '').trim().toLowerCase(); };
var normalizeRecordedDeliveryPath = function (value) {
    var normalized = normalize(typeof value === 'string' ? value : '');
    switch (normalized) {
        case 'protected_hls_gateway':
        case 'direct_cloudflare_stream':
        case 'source_fallback':
        case 'unknown':
            return normalized;
        default:
            return null;
    }
};
exports.normalizeRecordedDeliveryPath = normalizeRecordedDeliveryPath;
var classifyRecordedDeliveryPath = function (_a) {
    var deliveryProfile = _a.deliveryProfile, streamFormat = _a.streamFormat, src = _a.src, _b = _a.fallbackActive, fallbackActive = _b === void 0 ? false : _b, _c = _a.drmEnabled, drmEnabled = _c === void 0 ? false : _c;
    var normalizedProfile = normalize(deliveryProfile);
    var normalizedFormat = normalize(streamFormat);
    var normalizedSrc = normalize(src);
    if (fallbackActive
        || normalizedProfile.includes('private-source')
        || normalizedProfile.includes('source-fallback')
        || normalizedSrc.includes('/backend/api/courses/stream/')
        || (normalizedFormat === 'source' && !/cloudflarestream\.com|videodelivery\.net/.test(normalizedSrc))) {
        return 'source_fallback';
    }
    if (normalizedProfile.includes('cloudflare-stream')
        || /cloudflarestream\.com|videodelivery\.net/.test(normalizedSrc)) {
        return 'direct_cloudflare_stream';
    }
    if (drmEnabled
        || normalizedProfile.includes('private-hls')
        || normalizedProfile.includes('manifest')
        || normalizedProfile.includes('gateway')
        || normalizedProfile.includes('cache')
        || normalizedFormat === 'hls'
        || /\/backend\/api\/course-manifests\/|\/backend\/api\/courses\/h\/|master\.m3u8|\.m3u8(?:\?|$)/.test(normalizedSrc)) {
        return 'protected_hls_gateway';
    }
    return 'unknown';
};
exports.classifyRecordedDeliveryPath = classifyRecordedDeliveryPath;
var createDeliveryPathBreakdown = function () { return ({
    protected_hls_gateway: 0,
    direct_cloudflare_stream: 0,
    source_fallback: 0,
    unknown: 0,
}); };
exports.createDeliveryPathBreakdown = createDeliveryPathBreakdown;
