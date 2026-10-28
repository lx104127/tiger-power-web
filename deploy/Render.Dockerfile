FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=10000 PANEL_MODE=web PANEL_HOST=0.0.0.0 PANEL_DATA_DIR=/var/tiger-data
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy-ca \
    if [ -f /run/secrets/proxy-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy-ca; fi; \
    npm ci --omit=dev --ignore-scripts --fetch-retries=0 --fetch-timeout=20000 && npm cache clean --force
COPY . .
RUN mkdir -p /var/tiger-data && chown -R node:node /app
EXPOSE 10000
# The entrypoint initializes a newly mounted root-owned disk, then drops to UID
# 1000 before generating setup state or loading the web server and wallet CLI.
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "--use-env-proxy", "scripts/start-render.mjs"]
