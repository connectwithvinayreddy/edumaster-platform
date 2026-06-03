const env = import.meta.env as Record<string, string | undefined>;

export const LIVE_CLASSES_ENABLED = String(env.VITE_LIVE_CLASSES_ENABLED ?? 'false').trim().toLowerCase() === 'true';
