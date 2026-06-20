# VPN Panel

Self-hosted панель учёта VPN-инфраструктуры: серверы, домены, сертификаты, провайдеры, платежи, мониторинг.

**Стек:** Node.js 22 + SQLite (встроенный) + vanilla JS. Нет npm install, нет сборки.

---

## Быстрый старт

```bash
# 1. Копируем файлы на сервер
scp -r vpnpanel/ root@YOUR_SERVER:/opt/vpnpanel

# 2. На сервере
cd /opt/vpnpanel

# 3. Меняем пароль в docker-compose.yml (переменная ADMIN_PASSWORD)
nano docker-compose.yml

# 4. Запускаем
docker compose up -d

# 5. Открываем в браузере
http://YOUR_SERVER_IP:3000
```

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ADMIN_PASSWORD` | `changeme` | Пароль при первом запуске |
| `DATA_DIR` | `/app/data` | Путь к данным (БД + файл пароля) |
| `MONITOR_INTERVAL` | `5` | Интервал мониторинга (минуты) |
| `MONITOR_TIMEOUT` | `3000` | Таймаут TCP-проверки (мс) |
| `TG_TOKEN` | — | Токен Telegram-бота для уведомлений |
| `TG_CHAT` | — | Chat ID для уведомлений |

> Пароль задаётся только **один раз** при первом запуске (записывается в `data/password.txt`).
> При повторных запусках `ADMIN_PASSWORD` игнорируется — меняйте через настройки в интерфейсе.

---

## Telegram-уведомления

1. Создайте бота через @BotFather → получите `TG_TOKEN`
2. Добавьте бота в нужный чат/канал
3. Получите `TG_CHAT`: напишите `/start` боту, откройте `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Раскомментируйте и заполните переменные в `docker-compose.yml`
5. `docker compose up -d`

Бот уведомляет при смене статуса сервера: `up → down` и `down → up`.

---

## Мониторинг серверов

Панель делает TCP-соединение к `IP:PORT` каждые N минут.
- По умолчанию порт **22** (SSH) — достаточно для проверки доступности
- Можно указать любой открытый порт: 443, 8080, 54321 и т.д.
- История хранится **48 часов**, показывается полоска uptime из 32 тиков

---

## Типы активов

| Тип | Описание |
|---|---|
| `server` | VPS/выделенный сервер. Мониторинг доступности |
| `domain` | Доменное имя. Срок истечения |
| `cert` | SSL-сертификат. Срок истечения |
| `vpn` | VPN-сервис/протокол (VLESS, Hysteria2, ...) |
| `other` | Всё остальное |

---

## Платежи

Поддерживаемые валюты: **USDT, USD, EUR, RUB**.
Статистика по каждой валюте отдельно на дашборде и в разделе Платежи.

---

## Бэкап

```bash
# Всё хранится в папке data/ — достаточно её скопировать
tar -czf vpnpanel-backup-$(date +%F).tar.gz /opt/vpnpanel/data

# Cron: ежедневно в 3:00
0 3 * * * tar -czf /backup/vpnpanel-$(date +\%F).tar.gz /opt/vpnpanel/data
```

---

## Обновление

```bash
cd /opt/vpnpanel
# Заменить server.js и index.html новыми версиями
docker compose up -d --build
```

---

## Структура файлов

```
vpnpanel/
├── server.js       # Backend (Node.js, ~400 строк)
├── index.html      # Frontend (single-file SPA)
├── package.json    # Метаданные
├── Dockerfile
├── docker-compose.yml
└── data/           # Создаётся автоматически
    ├── vpnpanel.sqlite   # База данных
    └── password.txt      # Хэш пароля
```

---

## Порты и безопасность

По умолчанию панель слушает `0.0.0.0:3000`.

**Рекомендуется** закрыть порт 3000 файрволом и поставить reverse proxy:

```bash
# Закрыть прямой доступ
ufw delete allow 3000/tcp

# Nginx (пример)
server {
    listen 443 ssl;
    server_name panel.example.com;
    location / { proxy_pass http://127.0.0.1:3000; }
}
```

Или Caddy:
```
panel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
