FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY start.command start.bat README.md SPECIFICATION.md ./
RUN mkdir -p /app/data
EXPOSE 4173
CMD ["npm", "start"]
