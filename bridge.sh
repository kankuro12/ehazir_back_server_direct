#!/bin/bash

# CONFIGURATION
WIFI_IF="wlp1s0"
ETH_IF="enp2s0"
SUBNET="192.168.10.0"
IP_RANGE_START="192.168.10.10"
IP_RANGE_END="192.168.10.100"
GATEWAY_IP="192.168.10.1"
DNS_SERVERS="1.1.1.1, 8.8.8.8"

# REQUIRE ROOT
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root (use sudo)"
  exit 1
fi

echo "🔧 Setting static IP on $ETH_IF..."
ip addr flush dev $ETH_IF
ip addr add $GATEWAY_IP/24 dev $ETH_IF
ip link set $ETH_IF up

echo "🔄 Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1
sed -i 's/^#net.ipv4.ip_forward=./net.ipv4.ip_forward=1/' /etc/sysctl.conf

echo "🌐 Setting up NAT with iptables..."
iptables -t nat -A POSTROUTING -o $WIFI_IF -j MASQUERADE
iptables -A FORWARD -i $ETH_IF -o $WIFI_IF -j ACCEPT
iptables -A FORWARD -i $WIFI_IF -o $ETH_IF -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "📦 Installing isc-dhcp-server if not present..."
apt-get update
apt-get install -y isc-dhcp-server

echo "📝 Configuring DHCP server..."
cat > /etc/dhcp/dhcpd.conf <<EOF
subnet $SUBNET netmask 255.255.255.0 {
  range $IP_RANGE_START $IP_RANGE_END;
  option routers $GATEWAY_IP;
  option domain-name-servers $DNS_SERVERS;
}
EOF

echo "🔌 Setting DHCP server interface..."
sed -i "s/^INTERFACESv4=.*/INTERFACESv4=\"$ETH_IF\"/" /etc/default/isc-dhcp-server

echo "🚀 Restarting DHCP server..."
systemctl restart isc-dhcp-server

echo "✅ Wi-Fi sharing over Ethernet is now active!"