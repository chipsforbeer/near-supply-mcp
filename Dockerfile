# Supply server image for the local demo (docker compose up). Fictional data; not a production setup.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY docker/entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 8790
CMD ["sh", "./entrypoint.sh"]
