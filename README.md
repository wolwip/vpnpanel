# ⚡ VPN Panel

Self-hosted панель учёта VPN-инфраструктуры: серверы, домены, сертификаты, провайдеры, платежи, мониторинг.

**Стек:** Node.js 22 + SQLite (встроенный) + vanilla JS. Нет npm install, нет сборки — один `docker compose up`.

---

## 🚀 Быстрая установка (одна команда)

    bash <(curl -fsSL https://raw.githubusercontent.com/wolwip/vpnpanel/main/install.sh)

Скрипт в интерактивном режиме спросит:
- Папку установки и порт
- Пароль администратора
- Токен Telegram-бота для уведомлений (опционально)
- Домен для HTTPS через Caddy + Let's Encrypt (опционально)
- Интервал мониторинга серверов
- Настроить ли автобэкап данных

**Требования:** Ubuntu 22.04 / 24.04, root-доступ. Docker устанавливается автоматически.

---

## 📦 Ручная установка

    git clone https://github.com/wolwip/vpnpanel.git /opt/vpnpanel
    cd /opt/vpnpanel
    nano docker-compose.yml
    docker compose up -d

---

## ⚙️ Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ADMIN_PASSWORD` | `changeme` | Пароль при первом запуске |
| `DATA_DIR` | `/app/data` | Путь к данным |
| `MONITOR_INTERVAL` | `5` | Интервал мониторинга (минуты) |
| `MONITOR_TIMEOUT` | `3000` | Таймаут TCP-проверки (мс) |
| `TG_TOKEN` | — | Токен Telegram-бота |
| `TG_CHAT` | — | Chat ID для уведомлений |

> Пароль задаётся только **один раз** при первом запуске (сохраняется в `data/password.txt`).
> При повторных запусках `ADMIN_PASSWORD` игнорируется — меняйте через Настройки.

---

## 📋 Типы активов

| Тип | Описание |
|---|---|
| `server` | VPS/выделенный сервер. TCP-мониторинг доступности |
| `domain` | Доменное имя. Контроль срока истечения |
| `cert` | SSL-сертификат. Контроль срока истечения |
| `vpn` | VPN-сервис/протокол (VLESS, Hysteria2, ...) |
| `other` | Всё остальное |

---

## 💳 Платежи

- Валюты: **USDT, USD, EUR, RUB**
- Автосдвиг даты истечения при добавлении платежа (+1/3/6 мес, +1/2 года)
- Экспорт в CSV (активы и платежи)
- Статистика расходов по валютам на дашборде

---

## 🔔 Уведомления Telegram

Бот отправляет уведомления:
- 🔴 Сервер недоступен (up → down)
- ✅ Сервер восстановился (down → up)
- 🟡🟠🔴 Истечение срока за 30 / 7 / 3 дня

Получение токена: @BotFather → /newbot  
Получение chat_id: написать боту /start, затем открыть:  
https://api.telegram.org/bot<TOKEN>/getUpdates

---

## 🔒 HTTPS через Caddy

Установите Caddy и создайте /etc/caddy/Caddyfile:

    panel.example.com {
        reverse_proxy localhost:3000
    }

Затем:

    systemctl restart caddy

Caddy автоматически получит Let's Encrypt сертификат.

---

## 💾 Бэкап и восстановление

Бэкап (все данные в папке data/):

    tar -czf vpnpanel-backup.tar.gz /opt/vpnpanel/data

Восстановление на новом сервере:

    git clone https://github.com/wolwip/vpnpanel.git /opt/vpnpanel
    tar -xzf vpnpanel-backup.tar.gz -C /
    cd /opt/vpnpanel && docker compose up -d

---

## 🔄 Обновление

    cd /opt/vpnpanel
    git pull
    docker compose up -d --build

---

## 📁 Структура проекта

    vpnpanel/
    ├── server.js           # Backend (Node.js ~500 строк)
    ├── index.html          # Frontend (single-file SPA, vanilla JS)
    ├── install.sh          # Интерактивный установщик
    ├── Dockerfile
    ├── docker-compose.yml
    └── data/               # Создаётся автоматически
        ├── vpnpanel.sqlite     # База данных
        └── password.txt        # Хэш пароля
