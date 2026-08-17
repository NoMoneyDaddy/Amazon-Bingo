FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set fetch-retries 5 && npm config set fetch-retry-maxtimeout 120000 && npm ci --omit=dev
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
