FROM node:22-alpine

WORKDIR /srv/relay
COPY package.json ./
COPY src ./src
USER node
ENV BTGA_RELAY_PORT=30420
EXPOSE 30420/udp
CMD ["node", "src/server.js"]
