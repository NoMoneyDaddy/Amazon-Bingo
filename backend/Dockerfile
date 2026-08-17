FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --prefer-offline --fetch-retries=10 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
