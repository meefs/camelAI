FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
