export type RecordedDeliveryPath =
  | 'protected_hls_gateway'
  | 'direct_cloudflare_stream'
  | 'source_fallback'
  | 'unknown';

type RecordedDeliveryInput = {
  deliveryProfile?: string | null;
  streamFormat?: string | null;
  src?: string | null;
  fallbackActive?: boolean;
  drmEnabled?: boolean;
};

const normalize = (value: string | null | undefined) => String(value || '').trim().toLowerCase();

export const normalizeRecordedDeliveryPath = (value: unknown): RecordedDeliveryPath | null => {
  const normalized = normalize(typeof value === 'string' ? value : '');
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

export const classifyRecordedDeliveryPath = ({
  deliveryProfile,
  streamFormat,
  src,
  fallbackActive = false,
  drmEnabled = false,
}: RecordedDeliveryInput): RecordedDeliveryPath => {
  const normalizedProfile = normalize(deliveryProfile);
  const normalizedFormat = normalize(streamFormat);
  const normalizedSrc = normalize(src);

  if (
    fallbackActive
    || normalizedProfile.includes('private-source')
    || normalizedProfile.includes('source-fallback')
    || normalizedSrc.includes('/backend/api/courses/stream/')
    || (normalizedFormat === 'source' && !/cloudflarestream\.com|videodelivery\.net/.test(normalizedSrc))
  ) {
    return 'source_fallback';
  }

  if (
    normalizedProfile.includes('cloudflare-stream')
    || /cloudflarestream\.com|videodelivery\.net/.test(normalizedSrc)
  ) {
    return 'direct_cloudflare_stream';
  }

  if (
    drmEnabled
    || normalizedProfile.includes('private-hls')
    || normalizedProfile.includes('manifest')
    || normalizedProfile.includes('gateway')
    || normalizedProfile.includes('cache')
    || normalizedFormat === 'hls'
    || /\/backend\/api\/course-manifests\/|\/backend\/api\/courses\/h\/|master\.m3u8|\.m3u8(?:\?|$)/.test(normalizedSrc)
  ) {
    return 'protected_hls_gateway';
  }

  return 'unknown';
};

export const createDeliveryPathBreakdown = (): Record<RecordedDeliveryPath, number> => ({
  protected_hls_gateway: 0,
  direct_cloudflare_stream: 0,
  source_fallback: 0,
  unknown: 0,
});
