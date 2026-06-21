# VPN Panel

## Проект
Self-hosted панель учёта VPN-инфраструктуры.
Стек: Node.js 22 + SQLite (встроенный, node:sqlite) + vanilla JS (один index.html, без фреймворков).

## Структура
- `server.js` — backend, HTTP-сервер, API, мониторинг, Telegram
- `index.html` — frontend, single-file SPA, vanilla JS, тёмная/светлая тема
- `data/` — БД vpnpanel.sqlite + password.txt (не коммитить!)
- `install.sh` — интерактивный установщик

## Правила разработки
- Никаких npm-зависимостей — только встроенные модули Node.js
- Никакой сборки (webpack, vite) — index.html отдаётся как есть
- Frontend: vanilla JS, CSS-переменные для тем, минимум внешних запросов
- Backend: чистый http.createServer, SQLite через node:sqlite
- Язык интерфейса: русский
- После изменений: docker compose up -d --build
- После успешной сборки: git add, commit, push

## Деплой
- Docker: docker compose up -d --build
- HTTPS: Caddy reverse proxy → localhost:3000
- Домен: vpnpanel.twilightparadox.com
- GitHub: github.com/wolwip/vpnpanel (private)

## Команды
- Пересборка: docker compose up -d --build
- Логи: docker compose logs -f
- Бэкап: /root/backup-vpnpanel.sh

## Типы активов
server, domain, cert, vpn, other

## Валюты платежей
USDT, USD, EUR, RUB

## API эндпоинты
- POST /api/login — авторизация
- GET /api/assets — список активов с платежами и мониторингом
- POST /api/assets — создать актив
- PUT /api/assets/:id — обновить
- DELETE /api/assets/:id — удалить
- POST /api/payments — добавить платёж (shift_months/shift_years для автосдвига)
- DELETE /api/payments/:id — удалить платёж
- GET /api/providers — провайдеры
- POST /api/monitor/run — ручной запуск мониторинга
- GET /api/monitor/:id — история проверок (48 записей)
- GET /api/stats — статистика для дашборда
- GET /api/export/assets — экспорт CSV
- GET /api/export/payments — экспорт CSV
