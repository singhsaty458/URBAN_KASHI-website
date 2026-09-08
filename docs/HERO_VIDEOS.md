# Winter editorial video carousel

The homepage uses **three real, locally served stock-video edits**: a worn leather biker jacket, an outdoor bomber jacket, and a detail of a studded leather jacket carried over a shoulder. These replace the previous blazer/coat-fashion hero. **No verified parka or baseball/varsity clip is included**; bomber footage is not labelled as either. These are **not URBAN KASHI inventory and not an endorsement by the people shown**. The visible hero note identifies stock footage. No AI-generated or simulated video is presented as real footage.

## Sources and licensing

Individual clip pages and the [Mixkit Stock Video Free License](https://mixkit.co/license/#videoFree) were reviewed on **8 September 2026**. Each selected clip page explicitly permits commercial/personal use under the Free License, not the Restricted License. Contributor credits are available on the linked item pages. Credit is appreciated, not required. Review the [Mixkit User Terms](https://mixkit.co/terms/) for limitations. Do not resell/redistribute the footage as standalone stock, claim ownership, or imply model/brand endorsement. Replace stock with owner-authorized product footage before representing any real garment for sale.

| Local basename | Licensed source page | Public source rendition |
| --- | --- | --- |
| `winter-editorial-1` | [Man in biker gear approaches stationary motorcycle](https://mixkit.co/free-stock-video/man-in-biker-gear-approaches-stationary-motorcycle-1/) | <https://assets.mixkit.co/videos/1/1-720.mp4> |
| `winter-editorial-50551` | [A young man raises his professional camera to take a picture of a waterfall](https://mixkit.co/free-stock-video/a-young-man-raises-his-professional-camera-to-take-a-50551/) | <https://assets.mixkit.co/videos/50551/50551-720.mp4> |
| `winter-editorial-1391` | [Punk man holding a black leather jacket](https://mixkit.co/free-stock-video/punk-man-holding-a-black-leather-jacket-1391/) | <https://assets.mixkit.co/videos/1391/1391-720.mp4> |

Each local MP4 is an edit of up to six seconds of the site's HD-ready rendition (clip 1 begins at source second 5), encoded H.264/yuv420p with faststart, no audio stream and no source metadata. JPEG posters are extracted from the corresponding clip. Aspect ratio is preserved; the hero uses `object-fit: cover`, so crop varies between desktop/mobile.

Files live under `public/videos` and `public/images`. They are included in the normal Vite production build, work after cloning, and do not contact Mixkit from visitors' browsers. The app needs no API key, new service or video-processing package to play them. Normal clone/install instructions remain unchanged.

## Playback and accessibility

- Only the selected slide may play, muted and inline, with no native audio/fullscreen controls. Video sources are attached lazily when the active slide first becomes eligible for motion; inactive/unvisited slides do not request MP4s.
- Existing six-second autoplay changes slides with a horizontal left slide; Previous moves the opposite direction. Dots and touch/pen horizontal swipes work too. Vertical scrolling and pinch zoom remain available.
- Hover does **not** pause the active video or the six-second carousel. Keyboard focus inside the hero holds the carousel position and image drift, but the active video continues playing. This keeps controls stable without freezing footage.
- User Pause motion, hidden tab, offscreen hero and reduced-motion preference stop playback. User pause persists in local storage. Browser power/autoplay policies may still prevent playback; continuous playback is not forced around browser/accessibility restrictions.
- Explicit pause/reduced motion disables slide transition animation. Manual slide navigation still works, including when keyboard focus holds autoplay.
- Reduced-motion users see posters instead of video. `navigator.connection.saveData`, where supported at page load, also selects posters without requesting clips. Data-saver does not itself disable image/carousel animation; use Pause motion for that.
- Poster images stay underneath video. Decode/network errors or rejected autoplay retain the poster with functioning navigation. Failed clips are not continuously retried; reload can retry. No blank hero or unhandled `play()` rejection.
- Videos are decorative/hidden from assistive technology; descriptive poster alt text and labelled slide groups remain available. No speech/audio is included, so there is no spoken information requiring captions.

## Replace or refresh footage

1. Obtain permission/license for your real clips. Prefer 6–10 seconds, silent H.264 MP4, faststart, under roughly 2 MiB per edited clip, and a matching JPEG poster. Avoid flashing/strobing footage or essential text embedded in video.
2. Add the approved files under the existing public asset folders. Update [src/lib/hero.ts](../src/lib/hero.ts) with same-site paths, meaningful captions/alt text; keep source/license records here. These homepage assets are separate from admin product-photo uploads, which do not accept video.
3. Build again and reload the site. Verify crop, poster fallback, phone playback and reduced-motion behavior. Do not clear the user's stored pause preference to force autoplay.

The optional `npm.cmd run assets:videos` script recreates missing bundled demo clips/posters from the listed public source renditions. It requires an **already installed, approved FFmpeg** on PATH and approved network access, not for ordinary app startup. Existing outputs are not overwritten. Temporary downloads are isolated under the ignored website data directory and cleaned up. Network/source/license availability can change: stop and review failures, never disable TLS or bypass controls. Pexels winter-puffer candidates were not usable from this environment and were not included.