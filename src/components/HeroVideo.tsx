import { useEffect, useRef, useState } from 'react';

/** Only the visible/running slide requests video. Posters remain underneath on failure. */
export function HeroVideo({ src, poster, running }: { src: string; poster: string; running: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (running && !failed) setRequested(true);
  }, [running, failed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !requested || failed) return;
    let cancelled = false;
    if (running) {
      video.muted = true;
      void video.play().catch(() => {
        // Pause/unmount may cancel an outstanding play request; that is not a media failure.
        if (!cancelled) { setFailed(true); setReady(false); }
      });
    } else video.pause();
    return () => { cancelled = true; video.pause(); };
  }, [running, requested, failed]);

  return (
    <video
      ref={videoRef}
      className={`fashion-hero__video${ready && !failed ? ' is-ready' : ''}`}
      src={requested && !failed ? src : undefined}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      data-video-state={failed ? 'fallback' : ready ? 'ready' : 'poster'}
      onPlaying={() => setReady(true)}
      onError={() => { setFailed(true); setReady(false); }}
    />
  );
}