#!/bin/bash

# CONFIGURATION
SERVICE_NAME="ehazir_back_server_direct"
USER_NAME="$USER"
CURRENT_DIR=$(pwd)
WORK_DIR="$CURRENT_DIR"
SCRIPT_FILE="main.js"
NODE_PATH=$(which node)

SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME.service"

function install_service() {
  echo "🔧 Installing systemd service: $SERVICE_NAME"
  
  sudo bash -c "cat > $SERVICE_PATH" <<EOF
[Unit]
Description=Node.js Service - $SERVICE_NAME
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$WORK_DIR
ExecStart=$NODE_PATH $SCRIPT_FILE
Restart=always
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE_NAME
  echo "✅ Service installed and enabled. Use start/restart to begin."
}

function uninstall_service() {
  echo "🗑️  Uninstalling $SERVICE_NAME..."
  sudo systemctl stop $SERVICE_NAME 2>/dev/null
  sudo systemctl disable $SERVICE_NAME 2>/dev/null
  sudo rm -f $SERVICE_PATH
  sudo systemctl daemon-reload
  echo "✅ Service uninstalled successfully."
}

function start_service() {
  echo "🚀 Starting $SERVICE_NAME..."
  sudo systemctl start $SERVICE_NAME
}

function stop_service() {
  echo "🛑 Stopping $SERVICE_NAME..."
  sudo systemctl stop $SERVICE_NAME
}

function restart_service() {
  echo "🔄 Restarting $SERVICE_NAME..."
  sudo systemctl restart $SERVICE_NAME
}

function view_logs() {
  echo "📜 Viewing logs for $SERVICE_NAME..."
  sudo journalctl -u $SERVICE_NAME -f
}

function usage() {
  echo "Usage: $0 [install|uninstall|start|stop|restart|logs]"
}

# Main logic
case "$1" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  logs) view_logs ;;
  *) usage ;;
esac