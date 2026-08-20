# StreamDrop — Kick.com & YouTube Media Downloader

StreamDrop is a high-performance, lightweight web application for inspecting, downloading, and recording live streams, VODs, and clips from **Kick.com** and **YouTube** (up to 4K & 320kbps MP3 audio).

Engineered to run seamlessly on **Vercel (Free Serverless Tier)**, **Render (Docker Container)**, and **Local Node.js**.

---

## ⚡ Key Features

- **Kick.com Live Stream Recording & Stream Extraction**: Direct HLS stream capture via `ffmpeg` (`-c copy`) without re-encoding, preserving 100% original quality, plus 1-click M3U8 stream URL copy for VLC / external players.
- **Kick VODs & Clips**: Multi-quality selection (1080p60, 720p, etc.), instant direct CDN download for clips, and `+faststart` MP4 optimization.
- **Offline Channel Browser**: Automatically displays the last 12 VODs and 12 Clips if a channel is offline, with 1-click loading.
- **YouTube 4K/1080p & MP3 Extraction**: Powered by `yt-dlp` with format selection and audio quality control (320kbps, 256kbps, 128kbps) plus resilient serverless fallback.
- **HD Thumbnail Downloader**: One-click thumbnail downloads with server-side proxy to bypass CORS restrictions.
- **Vercel Free Host Optimized**: Native serverless architecture via `api/index.js` and `vercel.json` with zero-config instant deployment.
- **Real-time Live Progress**: Live download speed, file size counter, ETA, and elapsed time tracking.

---

## 📁 File Structure

```
streamdrop/
├── vercel.json         # Vercel Free Serverless configuration & routing
├── api/
│   └── index.js        # Vercel Serverless Function entry point
├── Dockerfile          # Production Docker container with ffmpeg + yt-dlp
├── render.yaml         # Render Blueprint specification
├── package.json        # Node.js dependencies & start script
├── server.js           # Express backend API & FFmpeg / yt-dlp job manager
├── public/
│   └── index.html      # Responsive Single Page frontend (Vanilla JS & CSS)
└── README.md           # Documentation and deployment instructions
```

---

## ▲ Deploy to Vercel (Free Serverless Tier)

### Method 1: Deploy via Vercel Dashboard & GitHub (Recommended)

1. **Push your code to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "StreamDrop release ready for Vercel"
   git branch -M main
   git remote add origin https://github.com/your-username/streamdrop.git
   git push -u origin main
   ```

2. **Open Vercel Dashboard**:
   - Go to [https://vercel.com/dashboard](https://vercel.com/dashboard).
   - Click **"Add New..."** ➔ **"Project"**.
   - Import your `streamdrop` GitHub repository.

3. **Deploy**:
   - Leave the Framework Preset as **Other** (or Auto-detected).
   - The Root Directory is `./`.
   - Click **"Deploy"**.
   - Vercel will automatically read `vercel.json`, deploy static assets from `public/`, and mount the Serverless Function at `api/index.js`.
   - Your live site will be ready in under 30 seconds at `https://streamdrop.vercel.app`!

---

### Method 2: Deploy with Vercel CLI

```bash
# Install Vercel CLI if you haven't already
npm install -g vercel

# Deploy directly from terminal
vercel

# Deploy to production domain
vercel --prod
```

---

## 🐳 Deploy to Render (Docker Method)

1. **Push code to GitHub**.
2. In [Render Dashboard](https://dashboard.render.com), click **"New +"** ➔ **"Web Service"** (or **"Blueprint"** to use `render.yaml`).
3. Select your repository.
4. Set Environment / Runtime to **`Docker`**.
5. Set Health Check Path to `/health`.
6. Click **"Create Web Service"**.

---

## 🚀 Local Development

### Prerequisites
- Node.js 18+
- `ffmpeg` installed and available in your `PATH`
- `yt-dlp` installed and available in your `PATH`

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm start
```

The application will be accessible at `http://localhost:3000` (or `http://localhost:10000`).

---

## 📡 API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/detect` | Auto-detects media type from URL and returns metadata & formats |
| `POST` | `/api/vod` | Loads Kick VOD metadata and HLS variants by video ID |
| `POST` | `/api/download/hls` | Starts Kick HLS stream recording or VOD download job |
| `POST` | `/api/download/clip` | Starts Kick direct clip download job |
| `POST` | `/api/download/youtube` | Starts YouTube video/audio download with `yt-dlp` |
| `POST` | `/api/stop/:jobId` | Stops active live stream recording and finalizes MP4 file |
| `GET` | `/api/status/:jobId` | Polls progress %, download speed, file size, and ETA |
| `GET` | `/api/file/:jobId` | Streams completed file to client and auto-deletes from disk |
| `GET` | `/api/thumbnail` | Proxies and downloads video/stream thumbnail image |
| `GET` | `/health` | Health check endpoint returning `{ ok: true }` |
