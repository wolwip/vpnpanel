#!/bin/bash
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✔${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✘${NC} $1"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}▶ $1${NC}"; }
clear
echo -e "${BOLD}${CYAN}  ⚡ VPN Panel — Установщик${NC}"
echo -e "  https://github.com/wolwip/vpnpanel\n"
[ "$EUID" -ne 0 ] && err "Запустите от root: sudo bash install.sh"
step "Параметры установки"
INSTALL_DIR_DEFAULT="/opt/vpnpanel"
read -rp "  Папка установки [${INSTALL_DIR_DEFAULT}]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$INSTALL_DIR_DEFAULT}"
read -rp "  Внутренний порт [3000]: " APP_PORT
APP_PORT="${APP_PORT:-3000}"
while true; do
  read -rsp "  Пароль администратора: " ADMIN_PASSWORD; echo ""
  read -rsp "  Повторите пароль: " ADMIN_PASSWORD2; echo ""
  [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD2" ] && [ ${#ADMIN_PASSWORD} -ge 6 ] && break
  [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD2" ] && warn "Пароли не совпадают" || warn "Минимум 6 символов"
done
echo -e "\n  ${CYAN}Telegram (Enter — пропустить)${NC}"
read -rp "  TG_TOKEN: " TG_TOKEN
[ -n "$TG_TOKEN" ] && read -rp "  TG_CHAT: " TG_CHAT
echo -e "\n  ${CYAN}HTTPS через Caddy${NC}"
read -rp "  Домен (Enter — пропустить): " DOMAIN
read -rp "  Интервал мониторинга в минутах [5]: " MONITOR_INTERVAL
MONITOR_INTERVAL="${MONITOR_INTERVAL:-5}"
read -rp "  Автобэкап данных каждую ночь? [Y/n]: " DO_BACKUP
DO_BACKUP="${DO_BACKUP:-Y}"
echo -e "\n${BOLD}  ── Параметры ──────────────────────────${NC}"
echo -e "  Папка:      ${INSTALL_DIR}"
echo -e "  Порт:       ${APP_PORT}"
echo -e "  Домен:      ${DOMAIN:-не указан}"
echo -e "  Telegram:   ${TG_TOKEN:+настроен}${TG_TOKEN:-не настроен}"
echo -e "  Мониторинг: каждые ${MONITOR_INTERVAL} мин"
echo ""
read -rp "  Начать установку? [Y/n]: " CONFIRM
CONFIRM="${CONFIRM:-Y}"
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Отменено."; exit 0; }
step "Системные пакеты"
apt-get update -qq && apt-get install -y -qq curl git ufw
ok "Установлены"
step "Docker"
if command -v docker &>/dev/null; then
  ok "Docker уже установлен: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker && systemctl start docker
  ok "Docker установлен"
fi
docker compose version &>/dev/null || err "Docker Compose не найден"
ok "Docker Compose: $(docker compose version --short)"
step "Загрузка VPN Panel"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Обновляем существующую установку..."
  cd "$INSTALL_DIR" && git pull origin main
  ok "Обновлено"
else
  git clone https://github.com/wolwip/vpnpanel.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Клонировано в ${INSTALL_DIR}"
fi
step "Конфигурация"
mkdir -p "${INSTALL_DIR}/data"
TG_LINES=""
[ -n "$TG_TOKEN" ] && TG_LINES="${TG_LINES}      TG_TOKEN: \"${TG_TOKEN}\"\n"
[ -n "$TG_CHAT"  ] && TG_LINES="${TG_LINES}      TG_CHAT: \"${TG_CHAT}\"\n"
cat > "${INSTALL_DIR}/docker-compose.yml" << DCEOF
services:
  vpnpanel:
    build: .
    container_name: vpnpanel
    ports:
      - "127.0.0.1:${APP_PORT}:3000"
    environment:
      ADMIN_PASSWORD: "${ADMIN_PASSWORD}"
      DATA_DIR: "/app/data"
      MONITOR_INTERVAL: "${MONITOR_INTERVAL}"
      MONITOR_TIMEOUT: "3000"
$(printf "$TG_LINES")    volumes:
      - ./data:/app/data
    restart: unless-stopped
DCEOF
ok "docker-compose.yml создан"
step "Сборка и запуск"
cd "$INSTALL_DIR" && docker compose up -d --build
ok "Контейнер запущен"
info "Ожидаем запуска..."
for i in $(seq 1 15); do
  curl -sf "http://localhost:${APP_PORT}/api/auth/check" &>/dev/null && ok "Сервис отвечает" && break
  sleep 2
  [ "$i" -eq 15 ] && warn "Сервис не ответил, проверьте: docker compose logs"
done
if [ -n "$DOMAIN" ]; then
  step "Caddy + HTTPS"
  if ! command -v caddy &>/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq && apt-get install -y -qq caddy
    ok "Caddy установлен"
  fi
  cat > /etc/caddy/Caddyfile << CEOF
${DOMAIN} {
    reverse_proxy localhost:${APP_PORT}
}
CEOF
  systemctl enable caddy && systemctl restart caddy
  sleep 3
  systemctl is-active --quiet caddy && ok "Caddy запущен" || warn "Проверьте: systemctl status caddy"
  ufw allow 80/tcp &>/dev/null || true
  ufw allow 443/tcp &>/dev/null || true
else
  ufw allow "${APP_PORT}/tcp" &>/dev/null || true
fi
step "Файрвол"
ufw allow 22/tcp &>/dev/null || true
ufw status | grep -q "Status: active" || ufw --force enable &>/dev/null
ok "Файрвол настроен"
if [[ "$DO_BACKUP" =~ ^[Yy]$ ]]; then
  step "Автобэкап"
  mkdir -p /root/backups
  cat > /root/backup-vpnpanel.sh << BEOF
#!/bin/bash
BACKUP_DIR="/root/backups"
mkdir -p \$BACKUP_DIR
tar -czf "\$BACKUP_DIR/vpnpanel-\$(date +%F).tar.gz" "${INSTALL_DIR}/data"
find \$BACKUP_DIR -name "vpnpanel-*.tar.gz" -mtime +30 -delete
echo "[\$(date)] Backup done"
BEOF
  chmod +x /root/backup-vpnpanel.sh
  (crontab -l 2>/dev/null | grep -v backup-vpnpanel; \
   echo "0 3 * * * /root/backup-vpnpanel.sh >> /root/backups/backup.log 2>&1") | crontab -
  ok "Автобэкап: каждую ночь в 3:00 → /root/backups/"
fi
EXT_IP=$(curl -sf ifconfig.me 2>/dev/null || echo "ВАШ_IP")
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  ✔ VPN Panel установлена!${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${NC}"
echo ""
[ -n "$DOMAIN" ] && echo -e "  🌐 ${BOLD}https://${DOMAIN}${NC}" || echo -e "  🌐 ${BOLD}http://${EXT_IP}:${APP_PORT}${NC}"
echo -e "  📁 Данные: ${INSTALL_DIR}/data/"
echo -e "  📋 Логи:   cd ${INSTALL_DIR} && docker compose logs -f"
echo -e "  🔄 Обновить: cd ${INSTALL_DIR} && git pull && docker compose up -d --build"
echo ""
