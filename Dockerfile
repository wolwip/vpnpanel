FROM node:22-alpine

WORKDIR /app

# Копируем файлы приложения
COPY package.json ./
COPY server.js ./
COPY recon.js recon-routes.js recon-dashboard.html ./
COPY index.html ./

# Создаём папку данных
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
