FROM node:22-slim
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server/main.js"]
