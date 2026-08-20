# Base image
FROM node:20-slim

# Install system dependencies (ffmpeg, python3, curl, ca-certificates)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      curl \
      ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY public ./public

# Environment and port config for Render
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
