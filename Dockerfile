# Gunakan Node.js 20 Debian Bookworm (Stabil)
FROM node:20-bookworm

# Instal dependency sistem untuk canvas, fonts, dan ffmpeg
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    fontconfig \
    fonts-dejavu \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Update font cache
RUN fc-cache -f -v

# Tentukan direktori kerja
WORKDIR /app

# Salin package.json dan instal library
COPY package.json package-lock.json ./
RUN npm install

# Salin semua file proyek
COPY . .

# Set Environment Variables agar Fontconfig menggunakan path /app/fonts.conf
ENV FONTCONFIG_PATH=/app
ENV FONTCONFIG_FILE=/app/fonts.conf

# Jalankan bot
CMD ["npm", "start"]
