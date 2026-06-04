import React from 'react';
import { ExternalLink } from 'lucide-react';
import { LiveClassAccess } from '../types';
import { ResilientHlsVideo } from './ResilientHlsVideo';

type ProtectedLivePlaybackProps = {
  access: LiveClassAccess;
};

export const ProtectedLivePlayback = ({ access }: ProtectedLivePlaybackProps) => {
  if (access.streamUrl) {
    return (
      <ResilientHlsVideo
        src={access.streamUrl}
        title={access.title}
        playbackMode="live"
        watermarkText={access.watermarkText}
        className="aspect-video w-full overflow-hidden rounded-[18px] bg-black"
        autoPlay
      />
    );
  }

  const externalUrl = access.replayExternalUrl || access.embedUrl || access.roomUrl;

  if (externalUrl) {
    return (
      <a
        href={externalUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#1e57d6]"
      >
        Open recording
        <ExternalLink className="h-4 w-4" />
      </a>
    );
  }

  return (
    <div className="rounded-[18px] border border-white/15 bg-white/8 px-4 py-5 text-sm text-white/70">
      {access.statusMessage || 'Recording playback is not available yet.'}
    </div>
  );
};
