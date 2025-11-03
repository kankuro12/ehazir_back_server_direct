#!/bin/bash

# CONFIGURATION
SERVICE_NAME="wifi-ethernet-bridge"
CURRENT_DIR=$(pwd)
BRIDGE_SCRIPT="$CURRENT_DIR/bridge.sh"

SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME.service"

function install_service() {
  echo "🔧 Installing systemd service: $SERVICE_NAME"
  
  # Install DHCP server if not present
  echo "📦 Installing isc-dhcp-server if not present..."
  sudo apt-get update
  sudo apt-get install -y isc-dhcp-server
  
  # Make bridge.sh executable
  chmod +x $BRIDGE_SCRIPT
  
  sudo bash -c "cat > $SERVICE_PATH" <<EOF
[Unit]
Description=WiFi to Ethernet Bridge Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=root
ExecStart=$BRIDGE_SCRIPT
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE_NAME
  echo "✅ Bridge service installed and enabled."
  echo "⚠️  Note: The bridge will start automatically on boot."
  echo "    Use 'sudo systemctl start $SERVICE_NAME' to start now."
}

function uninstall_service() {
  echo "🗑️  Uninstalling $SERVICE_NAME..."
  sudo systemctl stop $SERVICE_NAME 2>/dev/null
  sudo systemctl disable $SERVICE_NAME 2>/dev/null
  sudo rm -f $SERVICE_PATH
  sudo systemctl daemon-reload
  echo "✅ Service uninstalled."
}

function start_service() {
  echo "🚀 Starting $SERVICE_NAME..."
  sudo systemctl start $SERVICE_NAME
  sudo systemctl status $SERVICE_NAME --no-pager
}

function stop_service() {
  echo "🛑 Stopping $SERVICE_NAME..."
  sudo systemctl stop $SERVICE_NAME
}

function restart_service() {
  echo "🔄 Restarting $SERVICE_NAME..."
  sudo systemctl restart $SERVICE_NAME
  sudo systemctl status $SERVICE_NAME --no-pager
}

function status_service() {
  echo "📊 Status of $SERVICE_NAME..."
  sudo systemctl status $SERVICE_NAME --no-pager
}

function view_logs() {
  echo "📜 Viewing logs for $SERVICE_NAME..."
  sudo journalctl -u $SERVICE_NAME -f
}

function usage() {
  echo "WiFi to Ethernet Bridge Service Manager"
  echo ""
  echo "Usage: $0 [command]"
  echo ""
  echo "Commands:"
  echo "  install     Install the bridge as a systemd service"
  echo "  uninstall   Remove the bridge service"
  echo "  start       Start the bridge service"
  echo "  stop        Stop the bridge service"
  echo "  restart     Restart the bridge service"
  echo "  status      Show service status"
  echo "  logs        View service logs (follow mode)"
  echo ""
}

# Main logic
case "$1" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) status_service ;;
  logs) view_logs ;;
  *) usage ;;
esac
