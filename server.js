import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { gotScraping } from 'got-scraping';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup downloads directory in OS temp
const DOWNLOADS_DIR = path.join(os.tmpdir(), 'streamdrop_downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// In-memory job store
// jobId -> { id, type, status, progress, speed, size, rawBytes, eta, title, filename, filepath, isLive, process, error, createdAt }
const jobs = new Map();

// Standard headers for external requests
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://kick.com/'
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function sanitizeFilename(name) {
  if (!name) return 'streamdrop_media';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'streamdrop_media';
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(timeStr) || 0;
}

// Resilient Kick API Fetcher using TLS-fingerprinted got-scraping to bypass Cloudflare
async function fetchKickJson(endpointUrl, referer = 'https://kick.com/') {
  try {
    const res = await gotScraping({
      url: endpointUrl,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': referer,
        'Origin': 'https://kick.com'
      },
      responseType: 'json',
      timeout: { request: 12000 }
    });
    return res.body;
  } catch (err) {
    // If gotScraping threw, check if response was received with non-200
    if (err.response && err.response.body) {
      if (typeof err.response.body === 'object') return err.response.body;
      try {
        return JSON.parse(err.response.body);
      } catch (e) {}
    }
    throw err;
  }
}

async function fetchKickText(url, referer = 'https://kick.com/') {
  try {
    const res = await gotScraping({
      url,
      headers: {
        'Accept': '*/*',
        'Referer': referer
      },
      timeout: { request: 12000 }
    });
    return res.body;
  } catch (err) {
    // Fallback to axios if needed
    const ax = await axios.get(url, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': referer },
      timeout: 10000
    });
    return ax.data;
  }
}

// Resilient Kick VOD Resolver
async function resolveKickVod(videoIdOrSlug, channelSlug = '') {
  let sourceUrl = '';
  let resolvedTitle = '';
  let resolvedChannel = channelSlug || 'Kick Streamer';
  let resolvedDuration = 0;
  let resolvedThumb = '';
  let resolvedViews = 0;
  let resolvedCreatedAt = '';

  // 1. Direct Video lookup via v1 API (fast for UUIDs and numeric IDs)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(videoIdOrSlug) || /^\d+$/.test(videoIdOrSlug) || !channelSlug) {
    try {
      const vodRes = await fetchKickJson(`https://kick.com/api/v1/video/${videoIdOrSlug}`);
      if (vodRes && !vodRes.message && (vodRes.source || vodRes.playback_url || vodRes.video?.source)) {
        const v = vodRes.video || vodRes;
        const ls = vodRes.livestream || v.livestream;
        sourceUrl = v.source || v.playback_url || ls?.playback_url || vodRes.source || '';
        resolvedTitle = v.session_title || ls?.session_title || v.title || `Kick VOD #${videoIdOrSlug}`;
        resolvedChannel = ls?.channel?.user?.username || ls?.channel?.slug || v.channel?.user?.username || v.channel?.slug || channelSlug || 'Kick Streamer';
        const durRaw = v.duration || ls?.duration || 0;
        resolvedDuration = durRaw > 10000 ? Math.round(durRaw / 1000) : durRaw;
        resolvedThumb = v.thumbnail?.src || v.thumbnail?.url || ls?.thumbnail?.src || ls?.thumbnail?.url || v.thumbnail_url || '';
        resolvedViews = v.views || ls?.views || 0;
        resolvedCreatedAt = v.created_at || ls?.created_at || '';
      }
    } catch (e) {}
  }

  // 2. Multi-page channel search (pages 1 to 4 parallel = up to 100 recent VODs)
  if (!sourceUrl && channelSlug) {
    try {
      const pagePromises = [1, 2, 3, 4].map(p => 
        fetchKickJson(`https://kick.com/api/v2/channels/${channelSlug}/videos?page=${p}`)
          .then(r => Array.isArray(r) ? r : (r?.videos || []))
          .catch(() => [])
      );
      const pages = await Promise.all(pagePromises);
      const allVideos = pages.flat();

      const match = allVideos.find(v => 
        String(v.id) === String(videoIdOrSlug) ||
        v.video?.uuid === videoIdOrSlug ||
        (v.slug && v.slug.toLowerCase() === videoIdOrSlug.toLowerCase()) ||
        (v.slug && v.slug.toLowerCase().includes(videoIdOrSlug.toLowerCase())) ||
        (v.video?.id && String(v.video.id) === String(videoIdOrSlug))
      );

      if (match) {
        sourceUrl = match.source || match.video?.source || match.playback_url || '';
        resolvedTitle = match.session_title || match.title || `Kick VOD #${videoIdOrSlug}`;
        resolvedChannel = match.channel?.user?.username || match.channel?.slug || channelSlug;
        const durRaw = match.duration || match.video?.duration || 0;
        resolvedDuration = durRaw > 10000 ? Math.round(durRaw / 1000) : durRaw;
        resolvedThumb = match.thumbnail?.src || match.thumbnail?.url || match.thumbnail_url || '';
        resolvedViews = match.views || 0;
        resolvedCreatedAt = match.created_at || '';

        // If source was empty on listing item, query direct video UUID if available
        if (!sourceUrl && match.video?.uuid) {
          try {
            const detail = await fetchKickJson(`https://kick.com/api/v1/video/${match.video.uuid}`);
            if (detail && (detail.source || detail.playback_url)) {
              sourceUrl = detail.source || detail.playback_url;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // 3. Fallback: Check if channel livestream playback URL is active
  if (!sourceUrl && channelSlug) {
    try {
      const ch = await fetchKickJson(`https://kick.com/api/v2/channels/${channelSlug}`);
      if (ch && ch.livestream && (ch.livestream.playback_url || ch.playback_url)) {
        if (ch.livestream.slug === videoIdOrSlug || ch.livestream.session_title?.includes(videoIdOrSlug)) {
          sourceUrl = ch.livestream.playback_url || ch.playback_url;
          resolvedTitle = ch.livestream.session_title || `${channelSlug} Stream`;
          resolvedChannel = ch.user?.username || channelSlug;
        }
      }
    } catch (e) {}
  }

  return { sourceUrl, resolvedTitle, resolvedChannel, resolvedDuration, resolvedThumb, resolvedViews, resolvedCreatedAt };
}

// Parse HLS master m3u8 playlist to extract quality variants
async function parseMasterPlaylist(masterUrl) {
  try {
    const content = await fetchKickText(masterUrl);
    if (typeof content !== 'string') {
      return [{ quality: 'Source (Best)', label: 'Source (Best)', url: masterUrl, isBest: true }];
    }

    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          let variantUrl = nextLine;
          if (!variantUrl.startsWith('http://') && !variantUrl.startsWith('https://')) {
            variantUrl = new URL(variantUrl, baseUrl).toString();
          }

          // Parse attributes
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
          const fpsMatch = line.match(/FRAME-RATE=([\d\.]+)/i);
          const nameMatch = line.match(/NAME="([^"]+)"/i);

          const resolution = resMatch ? resMatch[1] : '';
          const height = resolution ? parseInt(resolution.split('x')[1], 10) : 0;
          const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : 0;

          let label = nameMatch ? nameMatch[1] : (height ? `${height}p` : 'Variant');
          if (fps && fps > 30 && !label.includes(String(fps))) {
            label = `${height || label}p${fps}`;
          }

          variants.push({
            quality: label,
            label,
            resolution: resolution || `${height}p`,
            height: height || 0,
            fps,
            bandwidth,
            bandwidthStr: bandwidth ? `${(bandwidth / 1000000).toFixed(1)} Mbps` : '',
            url: variantUrl,
            isBest: false
          });
        }
      }
    }

    if (variants.length === 0) {
      return [{ quality: 'Source (Original)', label: 'Source (Original)', url: masterUrl, isBest: true }];
    }

    // Sort variants by height & bandwidth descending
    variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    variants[0].isBest = true;

    return variants;
  } catch (err) {
    console.warn('Failed to parse HLS master playlist, using master directly:', err.message);
    return [{ quality: 'Source (Original)', label: 'Source (Original)', url: masterUrl, isBest: true }];
  }
}

// Execute yt-dlp --dump-json with serverless fallback
function getYoutubeInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
    execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
      if (!err && stdout) {
        try {
          const info = JSON.parse(stdout);
          return resolve(info);
        } catch (parseErr) {}
      }

      // Fallback for environments without yt-dlp (e.g. Vercel Serverless free tier)
      try {
        const oembedRes = await axios.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
          timeout: 6000
        });
        const oData = oembedRes.data;
        const videoIdMatch = url.match(/(?:v=|\/embed\/|\/watch\?v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
        const videoId = videoIdMatch ? videoIdMatch[1] : '';
        const thumb = videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : (oData.thumbnail_url || '');

        return resolve({
          title: oData.title || 'YouTube Video',
          uploader: oData.author_name || 'YouTube Creator',
          channel: oData.author_name || 'YouTube Creator',
          duration: 0,
          thumbnail: thumb,
          formats: [
            { format_id: '1080p', height: 1080, vcodec: 'avc1', fps: 60, filesize: null },
            { format_id: '720p', height: 720, vcodec: 'avc1', fps: 60, filesize: null },
            { format_id: '480p', height: 480, vcodec: 'avc1', fps: 30, filesize: null },
            { format_id: '360p', height: 360, vcodec: 'avc1', fps: 30, filesize: null }
          ]
        });
      } catch (oembedErr) {
        return reject(new Error(stderr || err?.message || 'Failed to inspect YouTube video. Please ensure URL is valid.'));
      }
    });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 1. POST /api/detect - Auto-detect URL type & return formats
app.post('/api/detect', async (req, res) => {
  const inputUrl = (req.body.url || '').trim();
  if (!inputUrl) {
    return res.status(400).json({ error: 'Please enter a valid URL or channel name' });
  }

  try {
    // ── Direct M3U8 / HLS stream URL support ──
    if (inputUrl.includes('.m3u8') || inputUrl.includes('playlist.m3u8') || inputUrl.includes('master.m3u8')) {
      const variants = await parseMasterPlaylist(inputUrl);
      const isLive = inputUrl.includes('live') || inputUrl.includes('fa72370b');
      return res.json({
        platform: 'kick',
        type: isLive ? 'live' : 'vod',
        isLive,
        title: isLive ? 'Live HLS Stream' : 'HLS Video Stream',
        channel: 'Direct Stream',
        duration: 0,
        durationFormatted: isLive ? 'LIVE' : '--:--',
        thumbnail: '',
        masterUrl: inputUrl,
        variants,
        url: inputUrl
      });
    }

    // ── Check YouTube ──
    const isYoutube = /(?:youtube\.com\/(?:watch\?|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)/i.test(inputUrl) ||
                      /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/i.test(inputUrl);

    if (isYoutube) {
      const info = await getYoutubeInfo(inputUrl);
      const isLive = Boolean(info.is_live || info.live_status === 'is_live');

      // Filter and group available video resolutions
      const formats = info.formats || [];
      const resolutionMap = new Map();

      // Available target resolutions
      const targetHeights = [2160, 1440, 1080, 720, 480, 360, 240, 144];

      targetHeights.forEach(targetH => {
        // Find formats matching this height
        const matching = formats.filter(f => f.vcodec !== 'none' && f.height === targetH);
        if (matching.length > 0) {
          // Sort by bitrate / tbr
          matching.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
          const bestForRes = matching[0];

          let label = `${targetH}p`;
          if (targetH === 2160) label = '4K (2160p)';
          if (targetH === 1440) label = '2K (1440p)';
          if (bestForRes.fps && bestForRes.fps > 30) label += ` ${bestForRes.fps}fps`;

          // Format selector for yt-dlp: combine best video at or below this resolution with best audio, or fallback
          const formatSelector = `bestvideo[height<=${targetH}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${targetH}]+bestaudio/best[height<=${targetH}]/best`;

          resolutionMap.set(targetH, {
            height: targetH,
            quality: label,
            label,
            fps: bestForRes.fps || 30,
            filesizeStr: bestForRes.filesize ? formatBytes(bestForRes.filesize) : (bestForRes.filesize_approx ? `~${formatBytes(bestForRes.filesize_approx)}` : ''),
            formatId: bestForRes.format_id,
            formatSelector,
            isBest: false
          });
        }
      });

      const videoFormats = Array.from(resolutionMap.values());
      if (videoFormats.length > 0) {
        videoFormats[0].isBest = true;
      } else {
        // Fallback default
        videoFormats.push({
          height: 1080,
          quality: 'Best Available (MP4)',
          label: 'Best Available (MP4)',
          formatSelector: 'bestvideo+bestaudio/best',
          isBest: true
        });
      }

      // Audio bitrates
      const audioFormats = [
        { bitrate: '320kbps', quality: '0', label: '320 kbps (High Quality MP3)', isBest: true },
        { bitrate: '256kbps', quality: '2', label: '256 kbps (Standard MP3)', isBest: false },
        { bitrate: '192kbps', quality: '4', label: '192 kbps (Medium MP3)', isBest: false },
        { bitrate: '128kbps', quality: '5', label: '128 kbps (Compact MP3)', isBest: false },
        { bitrate: '64kbps', quality: '9', label: '64 kbps (Voice/Low MP3)', isBest: false }
      ];

      return res.json({
        platform: 'youtube',
        type: isLive ? 'live' : 'video',
        isLive,
        title: info.title || 'YouTube Video',
        channel: info.uploader || info.channel || 'YouTube Creator',
        duration: info.duration || 0,
        durationFormatted: formatDuration(info.duration),
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : ''),
        viewCount: info.view_count || 0,
        videoFormats,
        audioFormats,
        url: inputUrl
      });
    }

    // ── Check Kick Clip ──
    const clipMatch = inputUrl.match(/kick\.com\/(?:[^\/]+\/clips\/|clips\/|clip\/)([a-zA-Z0-9_\-]+)/i);
    if (clipMatch) {
      const clipSlug = clipMatch[1];
      try {
        const clipDataRaw = await fetchKickJson(`https://kick.com/api/v2/clips/${clipSlug}`);
        const clipData = clipDataRaw.clip || clipDataRaw;
        const clipUrl = clipData.clip_url || clipData.video_url;

        if (!clipUrl) {
          throw new Error('Direct clip video URL not found');
        }

        const isHls = clipUrl.includes('.m3u8');
        let variants = [];
        if (isHls) {
          variants = await parseMasterPlaylist(clipUrl);
        }

        return res.json({
          platform: 'kick',
          type: 'clip',
          isLive: false,
          clipSlug,
          title: clipData.title || `Kick Clip - ${clipSlug}`,
          channel: clipData.channel?.username || clipData.creator?.username || 'Kick Streamer',
          duration: clipData.duration || 0,
          durationFormatted: formatDuration(clipData.duration),
          thumbnail: clipData.thumbnail_url || '',
          views: clipData.views || 0,
          createdAt: clipData.created_at || '',
          clipUrl,
          masterUrl: isHls ? clipUrl : '',
          variants,
          url: inputUrl
        });
      } catch (clipErr) {
        console.warn('Kick clip API error:', clipErr.message);
        return res.status(404).json({ error: `Could not load Kick clip "${clipSlug}". It may be private or deleted.` });
      }
    }

    // ── Check Kick VOD ──
    let isVodUrl = false;
    let channelSlugFromUrl = '';
    let videoIdOrSlug = '';

    const cleanInput = inputUrl.split('?')[0].trim();
    const uuidMatch = cleanInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
                      inputUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const vodUrlMatch = cleanInput.match(/kick\.com\/(?:([a-zA-Z0-9_.-]+)\/video[s]?\/|(?:video|videos)\/)([a-zA-Z0-9_.-]+)/i) ||
                        inputUrl.match(/kick\.com\/([a-zA-Z0-9_.-]+)\?.*video=([a-zA-Z0-9_.-]+)/i);

    if (vodUrlMatch) {
      isVodUrl = true;
      channelSlugFromUrl = (vodUrlMatch[1] && !['video', 'videos', 'clips', 'clip'].includes(vodUrlMatch[1].toLowerCase())) ? vodUrlMatch[1] : '';
      videoIdOrSlug = vodUrlMatch[2] || vodUrlMatch[1];
    } else if (uuidMatch) {
      isVodUrl = true;
      videoIdOrSlug = uuidMatch[1];
      const channelExtract = cleanInput.match(/kick\.com\/([a-zA-Z0-9_.-]+)/i);
      if (channelExtract && !['video', 'videos', 'clips', 'clip'].includes(channelExtract[1].toLowerCase())) {
        channelSlugFromUrl = channelExtract[1];
      }
    }

    if (isVodUrl && videoIdOrSlug) {
      try {
        const vodInfo = await resolveKickVod(videoIdOrSlug, channelSlugFromUrl);

        if (!vodInfo.sourceUrl) {
          let availableVods = [];
          if (channelSlugFromUrl) {
            try {
              const rawVods = await fetchKickJson(`https://kick.com/api/v2/channels/${channelSlugFromUrl}/videos`);
              const vidsList = Array.isArray(rawVods) ? rawVods : (rawVods?.videos || []);
              availableVods = vidsList.slice(0, 8).map(v => {
                const durSec = v.duration ? Math.round(v.duration / 1000) : (v.duration_seconds || 0);
                return {
                  id: v.video?.uuid || v.slug || v.id,
                  slug: v.slug || v.video?.uuid || v.id,
                  title: v.session_title || v.title || `VOD #${v.id}`,
                  duration: durSec,
                  durationFormatted: formatDuration(durSec),
                  thumbnail: v.thumbnail?.src || v.thumbnail?.url || v.thumbnail_url || '',
                  views: v.views || 0,
                  createdAt: v.created_at || ''
                };
              });
            } catch (e) {}
          }

          return res.status(404).json({
            error: `Kick VOD "${videoIdOrSlug}" was not found on Kick's servers (it may have been deleted, expired, or pruned).`,
            channelSlug: channelSlugFromUrl,
            availableVods
          });
        }

        const variants = await parseMasterPlaylist(vodInfo.sourceUrl);

        return res.json({
          platform: 'kick',
          type: 'vod',
          isLive: false,
          videoId: videoIdOrSlug,
          title: vodInfo.resolvedTitle || `Kick VOD #${videoIdOrSlug}`,
          channel: vodInfo.resolvedChannel || channelSlugFromUrl || 'Kick Streamer',
          duration: vodInfo.resolvedDuration || 0,
          durationFormatted: formatDuration(vodInfo.resolvedDuration || 0),
          thumbnail: vodInfo.resolvedThumb || '',
          views: vodInfo.resolvedViews || 0,
          createdAt: vodInfo.resolvedCreatedAt || '',
          masterUrl: vodInfo.sourceUrl,
          variants,
          url: inputUrl
        });
      } catch (vodErr) {
        console.warn('Kick VOD API error:', vodErr.message);
        return res.status(404).json({ error: `Could not load Kick VOD "${videoIdOrSlug}". ${vodErr.message || 'Please check if the video link is correct.'}` });
      }
    }

    // ── Check Kick Channel (Live or Offline Browser) ──
    let slug = inputUrl
      .replace(/^(https?:\/\/)?(www\.)?kick\.com\//i, '')
      .replace(/^\/@?/, '')
      .split('/')[0]
      .split('?')[0]
      .trim();

    if (slug) {
      try {
        let channelData = null;
        try {
          channelData = await fetchKickJson(`https://kick.com/api/v2/channels/${slug}`);
        } catch (v2Err) {
          // Fallback to v1
          channelData = await fetchKickJson(`https://kick.com/api/v1/channels/${slug}`);
        }

        if (!channelData || channelData.message === 'Channel not found' || (!channelData.user && !channelData.id && !channelData.slug)) {
          throw new Error('Channel not found');
        }

        const livestream = channelData.livestream;
        const isLive = Boolean(livestream && livestream.is_live !== false);

        // Fetch channel past livestreams (VODs) and clips for all channel queries
        let vods = [];
        let clips = [];

        try {
          const rawVods = await fetchKickJson(`https://kick.com/api/v2/channels/${slug}/videos`);
          const vidsList = Array.isArray(rawVods) ? rawVods : (rawVods?.videos || []);
          vods = vidsList.slice(0, 30).map(v => {
            const durSec = v.duration ? Math.round(v.duration / 1000) : (v.duration_seconds || 0);
            return {
              id: v.video?.uuid || v.id || v.video_id,
              channelSlug: slug,
              title: v.session_title || v.title || `Livestream #${v.id}`,
              duration: durSec,
              durationFormatted: formatDuration(durSec),
              thumbnail: v.thumbnail?.src || v.thumbnail?.url || v.thumbnail_url || '',
              views: v.views || 0,
              createdAt: v.created_at || '',
              source: v.source || v.video?.source || ''
            };
          });
        } catch (e) {
          console.warn('Could not fetch channel VODs:', e.message);
        }

        try {
          const rawClips = await fetchKickJson(`https://kick.com/api/v2/channels/${slug}/clips?sort=date&time=all&page=1`);
          const clipsList = Array.isArray(rawClips) ? rawClips : (rawClips?.clips || []);
          clips = clipsList.slice(0, 30).map(c => ({
            id: c.id,
            slug: c.slug || c.id,
            title: c.title || 'Kick Clip',
            duration: c.duration || 0,
            durationFormatted: formatDuration(c.duration),
            thumbnail: c.thumbnail_url || '',
            views: c.views || 0,
            createdAt: c.created_at || '',
            clipUrl: c.clip_url || c.video_url || ''
          }));
        } catch (e) {
          console.warn('Could not fetch channel Clips:', e.message);
        }

        if (isLive) {
          const playbackUrl = livestream.playback_url || channelData.playback_url;
          if (!playbackUrl) {
            throw new Error('Channel is live but playback stream URL is missing');
          }

          const variants = await parseMasterPlaylist(playbackUrl);

          return res.json({
            platform: 'kick',
            type: 'live',
            isLive: true,
            slug,
            channel: channelData.user?.username || channelData.slug || slug,
            profilePic: channelData.user?.profile_pic || '',
            title: livestream.session_title || `${channelData.user?.username || slug} Live Stream`,
            category: livestream.categories?.[0]?.name || livestream.category?.name || '',
            viewers: livestream.viewer_count || 0,
            startTime: livestream.created_at || '',
            thumbnail: livestream.thumbnail?.url || channelData.user?.profile_pic || '',
            masterUrl: playbackUrl,
            variants,
            vods,
            clips,
            url: `https://kick.com/${slug}`
          });
        } else {
          return res.json({
            platform: 'kick',
            type: 'offline_channel',
            isLive: false,
            slug,
            channel: channelData.user?.username || channelData.slug || slug,
            profilePic: channelData.user?.profile_pic || '',
            banner: channelData.banner_image?.url || '',
            bio: channelData.user?.bio || '',
            followersCount: channelData.followersCount || channelData.followers_count || 0,
            vods,
            clips,
            url: `https://kick.com/${slug}`
          });
        }
      } catch (chErr) {
        console.warn('Kick channel lookup error:', chErr.message);
        return res.status(404).json({
          error: `Could not find Kick channel or URL for "${inputUrl}". Please verify the channel name or link.`
        });
      }
    }

    return res.status(400).json({
      error: 'Unrecognized URL or channel. Please provide a YouTube link, Kick channel, VOD, or Clip URL.'
    });

  } catch (err) {
    console.error('Detection error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to detect or parse the provided media URL'
    });
  }
});

// 2. POST /api/vod - Load VOD by ID directly
app.post('/api/vod', async (req, res) => {
  const { videoId, channelSlug } = req.body;
  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  try {
    const vodInfo = await resolveKickVod(videoId, channelSlug);

    if (!vodInfo.sourceUrl) {
      return res.status(404).json({ error: `Playback stream source not found for Kick VOD "${videoId}". It may have expired or been pruned.` });
    }

    const variants = await parseMasterPlaylist(vodInfo.sourceUrl);

    return res.json({
      platform: 'kick',
      type: 'vod',
      isLive: false,
      videoId,
      title: vodInfo.resolvedTitle || `Kick VOD #${videoId}`,
      channel: vodInfo.resolvedChannel || channelSlug || 'Kick Streamer',
      duration: vodInfo.resolvedDuration || 0,
      durationFormatted: formatDuration(vodInfo.resolvedDuration || 0),
      thumbnail: vodInfo.resolvedThumb || '',
      views: vodInfo.resolvedViews || 0,
      createdAt: vodInfo.resolvedCreatedAt || '',
      masterUrl: vodInfo.sourceUrl,
      variants,
      url: channelSlug ? `https://kick.com/${channelSlug}/videos/${videoId}` : `https://kick.com/video/${videoId}`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to load VOD data' });
  }
});

// Pure Node.js native HLS segment engine (Runs on Vercel, Docker, VPS, Linux, Windows without yt-dlp or ffmpeg dependencies)
async function runNativeHlsDownload(streamUrl, filepath, job) {
  try {
    let playlistUrl = streamUrl;
    let text = await fetchKickText(playlistUrl);

    if (!text || typeof text !== 'string') {
      throw new Error('Failed to retrieve HLS playlist from stream URL');
    }

    // If master playlist with #EXT-X-STREAM-INF, select best variant
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
      let bestVariant = null;
      let maxBw = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
          const next = lines[i + 1];
          if (next && !next.startsWith('#')) {
            const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const fullUrl = next.startsWith('http') ? next : new URL(next, baseUrl).toString();
            if (bw > maxBw || !bestVariant) {
              maxBw = bw;
              bestVariant = fullUrl;
            }
          }
        }
      }

      if (bestVariant) {
        playlistUrl = bestVariant;
        text = await fetchKickText(playlistUrl);
      }
    }

    // Parse segments
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const playlistBase = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    const segments = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') || !line) continue;

      let segUrl = line;
      if (!segUrl.startsWith('http://') && !segUrl.startsWith('https://')) {
        segUrl = new URL(segUrl, playlistBase).toString();
      }
      segments.push(segUrl);
    }

    if (segments.length === 0) {
      // Direct stream / MP4 fallback
      const response = await axios({
        method: 'GET',
        url: playlistUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          'Referer': 'https://kick.com/'
        },
        timeout: 30000
      });

      const writer = fs.createWriteStream(filepath);
      let totalBytes = 0;
      response.data.on('data', chunk => {
        totalBytes += chunk.length;
        job.rawBytes = totalBytes;
        job.size = formatBytes(totalBytes);
      });
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      job.status = 'completed';
      job.progress = 100;
      job.eta = 'Done';
      return;
    }

    const totalSegments = segments.length;
    console.log(`[Job ${job.id}] Native HLS Engine starting download for ${totalSegments} segments.`);

    const writer = fs.createWriteStream(filepath);
    let completedCount = 0;
    let totalBytesDownloaded = 0;
    let lastBytes = 0;
    let lastTime = Date.now();

    const concurrency = 16;
    let nextIndex = 0;
    const downloadedBuffers = new Map();
    let nextToWrite = 0;
    let isAborted = false;

    job.abort = () => {
      isAborted = true;
      try { writer.end(); } catch (e) {}
    };

    const flushBuffers = () => {
      while (downloadedBuffers.has(nextToWrite)) {
        const buf = downloadedBuffers.get(nextToWrite);
        downloadedBuffers.delete(nextToWrite);
        writer.write(buf);
        nextToWrite++;
      }
    };

    const downloadWorker = async () => {
      while (nextIndex < totalSegments && !isAborted && job.status !== 'error') {
        const idx = nextIndex++;
        const segUrl = segments[idx];

        let retries = 4;
        let segBuffer = null;

        while (retries > 0 && !isAborted) {
          try {
            const segRes = await axios.get(segUrl, {
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': BROWSER_HEADERS['User-Agent'],
                'Referer': 'https://kick.com/',
                'Origin': 'https://kick.com'
              },
              timeout: 20000
            });
            segBuffer = Buffer.from(segRes.data);
            break;
          } catch (e) {
            retries--;
            if (retries === 0) {
              console.warn(`[Job ${job.id}] Segment ${idx} failed:`, e.message);
            } else {
              await new Promise(r => setTimeout(r, 250));
            }
          }
        }

        if (segBuffer) {
          downloadedBuffers.set(idx, segBuffer);
          totalBytesDownloaded += segBuffer.length;
          completedCount++;
          job.rawBytes = totalBytesDownloaded;
          job.size = formatBytes(totalBytesDownloaded);

          flushBuffers();

          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          
          const pct = Math.min(99, Math.round((completedCount / totalSegments) * 100));
          job.progress = Math.max(1, pct);

          if (elapsed >= 0.5) {
            const speedBps = (totalBytesDownloaded - lastBytes) / elapsed;
            job.speed = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;

            const remainingSegs = totalSegments - completedCount;
            const avgSpeedBytes = totalBytesDownloaded / Math.max(1, (now - job.startTime) / 1000);
            const avgBytesPerSeg = totalBytesDownloaded / Math.max(1, completedCount);
            const estRemainingBytes = remainingSegs * avgBytesPerSeg;
            const remainingSec = Math.round(estRemainingBytes / Math.max(1, avgSpeedBytes));
            job.eta = formatDuration(remainingSec);

            lastBytes = totalBytesDownloaded;
            lastTime = now;
          }
        } else {
          downloadedBuffers.set(idx, Buffer.alloc(0));
          flushBuffers();
        }
      }
    };

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, totalSegments); w++) {
      workers.push(downloadWorker());
    }

    await Promise.all(workers);
    flushBuffers();
    writer.end();

    await new Promise(resolve => {
      writer.on('finish', resolve);
      setTimeout(resolve, 600);
    });

    if (isAborted) {
      job.status = 'error';
      job.error = 'Download was stopped by user.';
      return;
    }

    if (fs.existsSync(filepath) && fs.statSync(filepath).size > 1024 * 50) {
      job.rawBytes = fs.statSync(filepath).size;
      job.size = formatBytes(job.rawBytes);
      job.progress = 100;
      job.status = 'completed';
      job.speed = 'Done';
      job.eta = 'Done';
      console.log(`[Job ${job.id}] Native HLS download completed: ${job.size}`);
    } else {
      job.status = 'error';
      job.error = 'File capture completed with empty stream data.';
    }
  } catch (err) {
    console.error(`[Job ${job.id}] Native HLS failure:`, err.message);
    job.status = 'error';
    job.error = err.message || 'Stream download failed.';
  }
}

// 3. POST /api/download/hls - Start Kick HLS download / live recording job
app.post('/api/download/hls', async (req, res) => {
  const { url, title, isLive, quality, duration } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'HLS stream URL is required' });
  }

  const jobId = uuidv4();
  const safeTitle = sanitizeFilename(title || (isLive ? 'Kick_Live_Recording' : 'Kick_VOD'));
  const filename = `${safeTitle}_${Date.now()}.mp4`;
  const filepath = path.join(DOWNLOADS_DIR, `${jobId}.mp4`);

  const job = {
    id: jobId,
    type: isLive ? 'kick_live' : 'kick_vod',
    status: isLive ? 'recording' : 'downloading',
    progress: 0,
    speed: '0.0 MB/s',
    size: '0 B',
    rawBytes: 0,
    eta: isLive ? 'LIVE' : '--:--',
    title: title || 'Kick Stream',
    filename,
    filepath,
    isLive: Boolean(isLive),
    totalDuration: Number(duration) || 0,
    startTime: Date.now(),
    process: null,
    error: null,
    createdAt: Date.now()
  };

  jobs.set(jobId, job);

  // Execute using pure Node.js native HLS engine
  runNativeHlsDownload(url, filepath, job).catch(err => {
    job.status = 'error';
    job.error = err.message;
  });

  return res.json({ jobId, status: job.status, filename });
});

// 4. POST /api/download/clip - Direct Kick clip download
app.post('/api/download/clip', async (req, res) => {
  const { clipUrl, title } = req.body;
  if (!clipUrl) {
    return res.status(400).json({ error: 'Clip URL is required' });
  }

  const jobId = uuidv4();
  const safeTitle = sanitizeFilename(title || 'Kick_Clip');
  const filename = `${safeTitle}_${Date.now()}.mp4`;
  const filepath = path.join(DOWNLOADS_DIR, `${jobId}.mp4`);

  const job = {
    id: jobId,
    type: 'kick_clip',
    status: 'downloading',
    progress: 0,
    speed: '0 MB/s',
    size: '0 B',
    rawBytes: 0,
    eta: '--:--',
    title: title || 'Kick Clip',
    filename,
    filepath,
    isLive: false,
    process: null,
    error: null,
    createdAt: Date.now()
  };

  jobs.set(jobId, job);

  // Fast direct stream download
  try {
    const response = await axios({
      method: 'GET',
      url: clipUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Referer': 'https://kick.com/'
      },
      timeout: 30000
    });

    const totalLength = parseInt(response.headers['content-length'] || '0', 10);
    const writer = fs.createWriteStream(filepath);
    let downloadedBytes = 0;
    let lastBytes = 0;
    let lastTime = Date.now();

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      job.rawBytes = downloadedBytes;
      job.size = formatBytes(downloadedBytes);

      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.8) {
        const speedBps = (downloadedBytes - lastBytes) / elapsed;
        job.speed = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;

        if (totalLength > 0) {
          const pct = Math.min(99, Math.round((downloadedBytes / totalLength) * 100));
          job.progress = pct;
          const remainingBytes = totalLength - downloadedBytes;
          const remainingSec = speedBps > 0 ? Math.round(remainingBytes / speedBps) : 0;
          job.eta = formatDuration(remainingSec);
        }

        lastBytes = downloadedBytes;
        lastTime = now;
      }
    });

    response.data.pipe(writer);

    writer.on('finish', () => {
      job.status = 'completed';
      job.progress = 100;
      job.eta = 'Done';
      job.speed = 'Done';
      if (fs.existsSync(filepath)) {
        job.size = formatBytes(fs.statSync(filepath).size);
      }
    });

    writer.on('error', (err) => {
      job.status = 'error';
      job.error = `File write error: ${err.message}`;
    });

    return res.json({ jobId, status: job.status, filename });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    return res.status(500).json({ error: err.message });
  }
});

// 5. POST /api/download/youtube - Start YouTube download with yt-dlp
app.post('/api/download/youtube', async (req, res) => {
  const { url, type, formatSelector, quality, title, isLive } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const jobId = uuidv4();
  const isAudio = type === 'audio';
  const isLiveStream = Boolean(isLive);
  const ext = isAudio ? 'mp3' : 'mp4';
  const safeTitle = sanitizeFilename(title || (isAudio ? 'YouTube_Audio' : 'YouTube_Video'));
  const filename = `${safeTitle}_${Date.now()}.${ext}`;
  const filepath = path.join(DOWNLOADS_DIR, `${jobId}.${ext}`);

  const job = {
    id: jobId,
    type: isLiveStream ? 'youtube_live' : (isAudio ? 'youtube_audio' : 'youtube_video'),
    status: isLiveStream ? 'recording' : 'downloading',
    progress: 0,
    speed: '0 MiB/s',
    size: '0 B',
    rawBytes: 0,
    eta: isLiveStream ? 'LIVE' : '--:--',
    title: title || 'YouTube Download',
    filename,
    filepath,
    isLive: isLiveStream,
    process: null,
    error: null,
    createdAt: Date.now()
  };

  jobs.set(jobId, job);

  // Build yt-dlp arguments with high-speed multi-threaded acceleration
  let ytdlpArgs = [
    '--no-warnings',
    '--newline',
    '--concurrent-fragments', '16',
    '-N', '8',
    '--buffer-size', '16M',
    '--http-chunk-size', '10M',
    '--progress-template', '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s'
  ];

  if (isAudio) {
    ytdlpArgs.push(
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', quality || '0',
      '-o', filepath,
      url
    );
  } else {
    // Video
    const selector = formatSelector || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best';
    ytdlpArgs.push(
      '--merge-output-format', 'mp4',
      '-f', selector,
      '-o', filepath,
      url
    );
  }

  try {
    const ytdlpProc = spawn('yt-dlp', ytdlpArgs);
    job.process = ytdlpProc;

    // Track file size
    const statInterval = setInterval(() => {
      // yt-dlp might write to .part or .mp4
      const possiblePaths = [filepath, `${filepath}.part`, `${filepath}.temp.mp4`];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          try {
            const stats = fs.statSync(p);
            job.rawBytes = stats.size;
            job.size = formatBytes(stats.size);
            break;
          } catch (e) {}
        }
      }
      if (job.status === 'completed' || job.status === 'error') {
        clearInterval(statInterval);
      }
    }, 800);

    ytdlpProc.stdout.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      for (const line of lines) {
        if (line.includes('|')) {
          const parts = line.split('|');
          if (parts.length >= 4) {
            const [pctStr, speedStr, etaStr, sizeStr] = parts;
            const pct = parseFloat(pctStr.replace('%', ''));
            if (!isNaN(pct)) {
              job.progress = Math.min(99, Math.max(0, Math.round(pct)));
            }
            if (speedStr && speedStr !== 'NA') job.speed = speedStr.trim();
            if (etaStr && etaStr !== 'NA') job.eta = etaStr.trim();
            if (sizeStr && sizeStr !== 'NA') job.size = sizeStr.trim();
          }
        } else if (line.includes('[download]') && line.includes('%')) {
          // Fallback regex for standard yt-dlp output
          const match = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d\.\w]+)\s+at\s+([\d\.\w\/]+)\s+ETA\s+([\d:]+)/);
          if (match) {
            job.progress = Math.min(99, Math.round(parseFloat(match[1])));
            job.size = match[2];
            job.speed = match[3];
            job.eta = match[4];
          }
        }
      }
    });

    ytdlpProc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('WARNING') && msg.includes('ERROR')) {
        job.error = msg.trim();
      }
    });

    ytdlpProc.on('close', (code) => {
      clearInterval(statInterval);
      job.process = null;

      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        job.rawBytes = stats.size;
        job.size = formatBytes(stats.size);

        if (stats.size > 1024) {
          job.status = 'completed';
          job.progress = 100;
          job.eta = 'Done';
          return;
        }
      }

      if (code === 0) {
        job.status = 'completed';
        job.progress = 100;
      } else if (job.status !== 'completed') {
        job.status = 'error';
        job.error = job.error || `yt-dlp exited with code ${code}`;
      }
    });

    ytdlpProc.on('error', (err) => {
      clearInterval(statInterval);
      job.process = null;
      job.status = 'error';
      job.error = `yt-dlp failed: ${err.message}`;
    });

    return res.json({ jobId, status: job.status, filename });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    return res.status(500).json({ error: err.message });
  }
});

// 6. POST /api/stop/:jobId - Stop live recording / active download and finalize file
app.post('/api/stop/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.process) {
    try {
      // Send 'q' to stdin for clean ffmpeg exit, or SIGINT
      if (job.process.stdin && job.process.stdin.writable) {
        job.process.stdin.write('q\n');
      }
      setTimeout(() => {
        if (job.process) {
          job.process.kill('SIGINT');
        }
      }, 500);

      job.status = 'completed';
      job.progress = 100;
      job.eta = 'Saved';
      return res.json({ ok: true, message: 'Recording stopped and finalized successfully' });
    } catch (err) {
      return res.status(500).json({ error: `Could not stop process: ${err.message}` });
    }
  }

  return res.json({ ok: true, message: 'Job was not actively recording' });
});

// 7. GET /api/status/:jobId - Poll job status
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    size: job.size,
    rawBytes: job.rawBytes,
    eta: job.eta,
    title: job.title,
    filename: job.filename,
    isLive: job.isLive,
    error: job.error
  });
});

// 8. GET /api/file/:jobId - Stream finished file to browser, then delete it
app.get('/api/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).send('Download job not found or expired.');
  }

  if (!fs.existsSync(job.filepath)) {
    return res.status(404).send('File not found on server or already downloaded.');
  }

  const stat = fs.statSync(job.filepath);
  const isAudio = job.filepath.endsWith('.mp3');
  const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';
  const cleanFilename = (job.filename || 'stream.mp4').replace(/[^\w\s.-]/gi, '_');

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${cleanFilename}"; filename*=UTF-8''${encodeURIComponent(job.filename || cleanFilename)}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  const readStream = fs.createReadStream(job.filepath);
  readStream.pipe(res);

  // Keep the file available for 15 minutes so the user can re-download or tap multiple times if needed
  if (!job.cleanupTimer) {
    job.cleanupTimer = setTimeout(() => {
      try {
        if (fs.existsSync(job.filepath)) {
          fs.unlinkSync(job.filepath);
          console.log(`Cleaned up temporary file: ${job.filepath}`);
        }
      } catch (err) {
        console.warn('Failed to delete temp file:', err.message);
      }
    }, 15 * 60 * 1000);
  }
});

// Return array of direct CDN segments for ultra-fast, zero-timeout client-side stream downloading
app.get('/api/hls-segments', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing stream URL' });
  }

  try {
    let playlistUrl = targetUrl;
    let text = await fetchKickText(playlistUrl);

    if (!text || typeof text !== 'string') {
      return res.status(500).json({ error: 'Could not fetch stream playlist' });
    }

    // Handle master playlist
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
      let bestVariant = null;
      let maxBw = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
          const next = lines[i + 1];
          if (next && !next.startsWith('#')) {
            const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const fullUrl = next.startsWith('http') ? next : new URL(next, baseUrl).toString();
            if (bw > maxBw || !bestVariant) {
              maxBw = bw;
              bestVariant = fullUrl;
            }
          }
        }
      }

      if (bestVariant) {
        playlistUrl = bestVariant;
        text = await fetchKickText(playlistUrl);
      }
    }

    const isLive = !text.includes('#EXT-X-ENDLIST');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const playlistBase = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    const segments = [];
    let totalDuration = 0;
    let currentByteRange = null;
    let currentDur = 0;
    let lastOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const match = line.replace('#EXT-X-BYTERANGE:', '').trim().match(/^(\d+)(?:@(\d+))?$/);
        if (match) {
          const length = parseInt(match[1], 10);
          const offset = match[2] !== undefined ? parseInt(match[2], 10) : lastOffset;
          currentByteRange = { length, offset };
          lastOffset = offset + length;
        }
        continue;
      }
      if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/);
        if (durMatch) currentDur = parseFloat(durMatch[1]);
        continue;
      }
      if (line.startsWith('#EXT-X-PREFETCH:')) {
        let pUrl = line.replace('#EXT-X-PREFETCH:', '').trim();
        if (pUrl) {
          if (!pUrl.startsWith('http://') && !pUrl.startsWith('https://')) {
            pUrl = new URL(pUrl, playlistBase).toString();
          }
          segments.push({
            url: pUrl,
            duration: currentDur || 2,
            byteRange: currentByteRange
          });
          totalDuration += currentDur || 2;
          currentByteRange = null;
          currentDur = 0;
        }
        continue;
      }
      if (line.startsWith('#') || !line) continue;

      let segUrl = line;
      if (!segUrl.startsWith('http://') && !segUrl.startsWith('https://')) {
        segUrl = new URL(segUrl, playlistBase).toString();
      }
      segments.push({
        url: segUrl,
        duration: currentDur,
        byteRange: currentByteRange
      });
      totalDuration += currentDur;
      currentByteRange = null;
      currentDur = 0;
    }

    return res.json({
      success: true,
      playlistUrl,
      isLive,
      totalDuration: Math.round(totalDuration),
      totalSegments: segments.length,
      segments
    });
  } catch (err) {
    console.error('hls-segments error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to parse stream segments' });
  }
});

// Proxy single segment with CORS and Range header support in case of direct fetch failure
app.get('/api/proxy-segment', async (req, res) => {
  const segUrl = req.query.url;
  if (!segUrl) return res.status(400).send('Missing url');

  try {
    const upstreamHeaders = {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Referer': 'https://kick.com/',
      'Origin': 'https://kick.com'
    };
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const upstream = await axios.get(segUrl, {
      responseType: 'stream',
      headers: upstreamHeaders,
      timeout: 25000,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const headers = {
      'Content-Type': upstream.headers['content-type'] || 'video/MP2T',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Origin, Content-Type, Accept',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'public, max-age=86400'
    };
    if (upstream.headers['content-range']) {
      headers['Content-Range'] = upstream.headers['content-range'];
    }
    if (upstream.headers['content-length']) {
      headers['Content-Length'] = upstream.headers['content-length'];
    }
    if (upstream.headers['accept-ranges']) {
      headers['Accept-Ranges'] = upstream.headers['accept-ranges'];
    }

    res.writeHead(upstream.status || 200, headers);
    upstream.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).send(e.message);
  }
});

// Direct HLS streaming download endpoint (100% compatible with Vercel serverless, Render, VPS, and Docker)
app.get('/api/stream-hls', async (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename || 'stream.mp4';
  const cleanFilename = (filename.endsWith('.mp4') ? filename : `${filename}.mp4`).replace(/[^\w\s.-]/gi, '_');

  if (!targetUrl) {
    return res.status(400).send('Missing stream URL');
  }

  try {
    let playlistUrl = targetUrl;
    let text = await fetchKickText(playlistUrl);

    if (!text || typeof text !== 'string') {
      return res.status(500).send('Could not fetch stream playlist');
    }

    // Handle master playlist
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
      let bestVariant = null;
      let maxBw = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
          const next = lines[i + 1];
          if (next && !next.startsWith('#')) {
            const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const fullUrl = next.startsWith('http') ? next : new URL(next, baseUrl).toString();
            if (bw > maxBw || !bestVariant) {
              maxBw = bw;
              bestVariant = fullUrl;
            }
          }
        }
      }

      if (bestVariant) {
        playlistUrl = bestVariant;
        text = await fetchKickText(playlistUrl);
      }
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const playlistBase = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    const segments = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') || !line) continue;
      let segUrl = line;
      if (!segUrl.startsWith('http://') && !segUrl.startsWith('https://')) {
        segUrl = new URL(segUrl, playlistBase).toString();
      }
      segments.push(segUrl);
    }

    if (segments.length === 0) {
      // Direct stream fallback
      return res.redirect(playlistUrl);
    }

    console.log(`[Stream-HLS] Starting real-time stream pipe for ${segments.length} segments to client (${cleanFilename})`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${cleanFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    // Stream segments sequentially to response
    for (let i = 0; i < segments.length; i++) {
      if (clientDisconnected) break;
      const segUrl = segments[i];

      let attempts = 3;
      while (attempts > 0 && !clientDisconnected) {
        try {
          const segRes = await axios.get(segUrl, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': BROWSER_HEADERS['User-Agent'],
              'Referer': 'https://kick.com/',
              'Origin': 'https://kick.com'
            },
            timeout: 15000
          });

          if (!clientDisconnected) {
            res.write(Buffer.from(segRes.data));
          }
          break;
        } catch (e) {
          attempts--;
          if (attempts === 0) {
            console.warn(`[Stream-HLS] Skipped segment ${i}:`, e.message);
          } else {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }
    }

    if (!clientDisconnected) {
      res.end();
    }
  } catch (err) {
    console.error('Stream-HLS error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Stream download failed: ' + err.message);
    }
  }
});

// 9. GET /api/thumbnail - Proxy thumbnail download
app.get('/api/thumbnail', async (req, res) => {
  const imageUrl = req.query.url;
  const filename = sanitizeFilename(req.query.filename || 'thumbnail') + '.jpg';

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).send('Thumbnail URL is required');
  }

  try {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    const stream = gotScraping.stream(imageUrl, {
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://kick.com/'
      }
    });

    stream.on('error', (err) => {
      console.error('Thumbnail stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).send('Failed to fetch thumbnail');
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Thumbnail proxy error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Failed to fetch thumbnail');
    }
  }
});

// 10. GET /health - Render health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'StreamDrop',
    uptime: Math.round(process.uptime()),
    activeJobs: jobs.size,
    timestamp: new Date().toISOString()
  });
});

// Fallback for SPA routing - serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Periodic cleanup of old orphan files (> 1 hour old) (only in persistent server mode)
if (!process.env.VERCEL) {
  setInterval(() => {
    try {
      if (!fs.existsSync(DOWNLOADS_DIR)) return;
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const now = Date.now();
      for (const f of files) {
        const p = path.join(DOWNLOADS_DIR, f);
        const stat = fs.statSync(p);
        if (now - stat.mtimeMs > 3600000) {
          fs.unlinkSync(p);
          console.log(`Cleaned up stale temp file: ${f}`);
        }
      }
    } catch (err) {
      console.warn('Cleanup interval error:', err.message);
    }
  }, 900000); // every 15 minutes

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 StreamDrop server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;

