FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PANEL_MODE=web PANEL_PORT=4400 PANEL_HOST=0.0.0.0 PANEL_DATA_DIR=/app/data
COPY package.json package-lock.json ./
# Web wallet slots use file storage; the native OS keychain is deliberately
# unavailable in this headless image, so its installation script is unnecessary.
RUN --mount=type=secret,id=proxy-ca \
    if [ -f /run/secrets/proxy-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy-ca; fi; \
    npm ci --omit=dev --ignore-scripts --fetch-retries=0 --fetch-timeout=20000 && npm cache clean --force
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4400/health',{headers:{host:new URL(process.env.PANEL_PUBLIC_URL).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--use-env-proxy", "panel/server.mjs"]
