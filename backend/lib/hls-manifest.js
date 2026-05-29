const path = require('path');

const assetMimeTypeByExtension = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.key': 'application/octet-stream',
};

const normalizeManifestText = (manifestText) => String(manifestText || '').replace(/\r\n/g, '\n');

const appendEndListToMediaManifest = (manifestText) => {
  const normalized = normalizeManifestText(manifestText);
  if (!normalized.trim()) {
    return '#EXTM3U\n#EXT-X-ENDLIST\n';
  }

  if (/#EXT-X-ENDLIST\b/.test(normalized)) {
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  }

  const isMediaPlaylist = /#EXTINF:|#EXT-X-TARGETDURATION:|#EXT-X-MAP:|#EXT-X-PART:/.test(normalized)
    && !/#EXT-X-STREAM-INF:/.test(normalized);

  if (!isMediaPlaylist) {
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  }

  return `${normalized.replace(/\s+$/u, '')}\n#EXT-X-ENDLIST\n`;
};

const rewriteHlsManifestUris = (manifestText, resolver) => normalizeManifestText(manifestText)
  .split('\n')
  .map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return line;
    }

    if (!trimmed.startsWith('#')) {
      return resolver(trimmed);
    }

    return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
      if (!uri || String(uri).startsWith('data:')) {
        return `URI="${uri}"`;
      }

      return `URI="${resolver(uri)}"`;
    });
  })
  .join('\n');

const getHlsAssetMimeType = (assetPath, fallback = 'application/octet-stream') => {
  const extension = path.extname(String(assetPath || '').split('?')[0]).toLowerCase();
  return assetMimeTypeByExtension[extension] || fallback;
};

module.exports = {
  assetMimeTypeByExtension,
  appendEndListToMediaManifest,
  rewriteHlsManifestUris,
  getHlsAssetMimeType,
};
