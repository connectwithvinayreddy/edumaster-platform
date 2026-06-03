export type HlsRuntimeLevel = {
  height?: number | null;
  bitrate?: number | null;
};

export type HlsRuntimeEvents = {
  MANIFEST_PARSED: string;
  LEVEL_SWITCHED: string;
  FRAG_LOADED: string;
  FRAG_LOADING: string;
  ERROR: string;
};

export type HlsRuntimeInstance = {
  destroy(): void;
  levels?: HlsRuntimeLevel[];
  startLevel: number;
  nextLevel: number;
  currentLevel: number;
  autoLevelCapping: number;
  startLoad(startPosition?: number): void;
  recoverMediaError(): void;
  on(event: string, listener: (_event: string, data: unknown) => void): void;
  off(event: string, listener: (_event: string, data: unknown) => void): void;
  loadSource(source: string): void;
  attachMedia(media: HTMLMediaElement): void;
};

export type HlsRuntimeModule = {
  default: {
    new(config?: unknown): HlsRuntimeInstance;
    isSupported(): boolean;
    Events: HlsRuntimeEvents;
  };
};

let hlsRuntimePromise: Promise<HlsRuntimeModule> | null = null;

export const loadHlsRuntime = () => {
  if (!hlsRuntimePromise) {
    hlsRuntimePromise = import('hls.js') as Promise<HlsRuntimeModule>;
  }
  return hlsRuntimePromise;
};
