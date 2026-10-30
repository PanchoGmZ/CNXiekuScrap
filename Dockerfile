FROM apify/actor-node:24
WORKDIR /usr/src/app
COPY --chown=myuser:myuser package*.json .npmrc ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund
COPY --chown=myuser:myuser src ./src
COPY --chown=myuser:myuser .actor ./.actor
CMD ["node", "src/main.js"]
