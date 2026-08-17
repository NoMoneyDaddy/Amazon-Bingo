FROM node:22-alpine
WORKDIR /app
COPY backend/package.json ./package.json
COPY backend/src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
