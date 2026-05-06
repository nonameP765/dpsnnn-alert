FROM oven/bun:1.3-debian

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY index.ts discover.ts tsconfig.json config.json ./

ENV TZ=Asia/Seoul

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "index.ts"]
