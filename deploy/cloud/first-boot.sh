#!/usr/bin/env bash
# Primer arranque de la máquina virtual: Docker y límites del sistema para decenas de miles de conexiones.
set -euxo pipefail

curl -fsSL https://get.docker.com | sh
# El usuario administrador se llama distinto en cada nube, pero siempre tiene UID 1000.
usermod -aG docker "$(getent passwd 1000 | cut -d: -f1)"

# Docker usa NAT entre contenedores: cada conexión pasa por la tabla de conntrack.
echo nf_conntrack > /etc/modules-load.d/preconteo.conf
modprobe nf_conntrack

cat > /etc/sysctl.d/90-preconteo.conf <<'SYSCTL'
fs.file-max = 2000000
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.netfilter.nf_conntrack_max = 1000000
SYSCTL
sysctl --system
