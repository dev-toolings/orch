#!/usr/bin/env bash
# Host hardening for the machine Kiba lives on, matching `orch ops check`
# (parity case EM40): key-only SSH, root login refused, ufw on with SSH open
# to the LAN only. Docker-published ports are reported, never changed: they
# are fixed in each project's compose file (docs/host-hardening.md).
#
#   sudo infra/host/harden.sh check      show the current state and the plan (default, writes nothing)
#   sudo infra/host/harden.sh apply --dry-run   every check of apply, sshd and ufw dry runs, changes nothing
#   sudo infra/host/harden.sh apply      harden; refuses when it could lock you out
#   sudo infra/host/harden.sh rollback   remove the SSH drop-in, disable ufw
#   options: --lan CIDR (default: the network of the default route)
#            --force    apply even with an SSH session from outside the LAN
#
# Test hooks: HARDEN_ROOT prefixes /etc paths, HARDEN_EUID stands in for EUID.
set -euo pipefail

ROOT=${HARDEN_ROOT:-}
EUID_=${HARDEN_EUID:-$EUID}
SSHD_MAIN="$ROOT/etc/ssh/sshd_config"
DROPIN="$ROOT/etc/ssh/sshd_config.d/10-orch-hardening.conf"
UFW_CONF="$ROOT/etc/ufw/ufw.conf"
WANT='PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no'
# Docker's default address pools (172.17-31/16, then 192.168.x/20 slices
# above 192.168.0.0/20): containers reach host services, the LAN does not.
DOCKER_POOLS="172.16.0.0/12 192.168.16.0/20 192.168.32.0/19 192.168.64.0/18 192.168.128.0/17"

say() { printf '%s\n' "$*"; }
die() { printf 'harden: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=check
LAN=""
FORCE=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    check|apply|rollback) MODE=$1; shift ;;
    --lan) LAN=${2:?--lan needs a CIDR}; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

need_root() { [ "$EUID_" -eq 0 ] || die "$MODE needs root: sudo $0 $MODE"; }

# The network of the interface carrying the default route, e.g. 192.168.1.0/24.
detect_lan() {
  local dev cidr
  dev=$(ip -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  [ -n "$dev" ] || die "no default route: pass --lan CIDR"
  cidr=$(ip -4 -o addr show dev "$dev" | awk '{print $4; exit}')
  [ -n "$cidr" ] || die "no IPv4 address on $dev: pass --lan CIDR"
  python3 -c 'import ipaddress, sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$cidr"
}

in_lan() { python3 -c 'import ipaddress, sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network(sys.argv[2]) else 1)' "$1" "$2"; }

# Peers of established SSH sessions (IPv4-mapped addresses unwrapped).
ssh_peers() {
  ss -tnH state established '( sport = :22 )' | awk '{print $NF}' | sed -E 's/^\[?(::ffff:)?//; s/\]?:[0-9]+$//' | sort -u
}

effective_ssh() {
  if [ "$EUID_" -eq 0 ]; then
    sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' | sort
  else
    say "(not root: sshd -T unavailable, run with sudo for the effective values)"
  fi
}

ufw_state() {
  if [ "$EUID_" -eq 0 ]; then ufw status verbose
  elif grep -qE '^\s*ENABLED\s*=\s*yes' "$UFW_CONF" 2>/dev/null; then say "ufw enabled (from ufw.conf)"
  else say "ufw disabled (from ufw.conf)"; fi
}

# The owning process is only visible to root.
exposed() {
  local cols='{print $4}'
  [ "$EUID_" -eq 0 ] && cols='{print $4, $NF}'
  ss -tlnpH | awk "$cols" | grep -vE '^(127\.|\[::1\]|::1)' || true
}

check() {
  [ -n "$LAN" ] || LAN=$(detect_lan)
  say "== SSH (effective)"; effective_ssh
  if [ -f "$DROPIN" ] && [ "$(cat "$DROPIN")" = "$WANT" ]; then say "drop-in $DROPIN: in place"; else say "drop-in $DROPIN: to write"; fi
  say "== Firewall"; ufw_state
  say "plan: deny incoming, allow outgoing, SSH from $LAN, Docker networks to the host ($DOCKER_POOLS)"
  say "== SSH sessions now"
  local p
  for p in $(ssh_peers); do
    if in_lan "$p" "$LAN"; then say "$p (LAN)"; else say "$p OUTSIDE $LAN: apply refuses unless --force"; fi
  done
  say "== Listening beyond localhost (ufw does not cover Docker-published ports)"
  exposed
}

# The user who ran sudo must be able to log in with a key afterwards.
check_keys() {
  local user=${SUDO_USER:-} home keys
  [ -n "$user" ] && [ "$user" != root ] || die "run through sudo from your own account, so its SSH keys can be checked"
  home=$(getent passwd "$user" | cut -d: -f6)
  keys="$ROOT$home/.ssh/authorized_keys"
  grep -qE '^(ssh-|ecdsa-|sk-)' "$keys" 2>/dev/null || die "no SSH key in $keys: password login would be your only way in"
  say "ok   $user has $(grep -cE '^(ssh-|ecdsa-|sk-)' "$keys") SSH key(s)"
}

check_sessions() {
  local p outside=0
  for p in $(ssh_peers); do in_lan "$p" "$LAN" || { say "warn SSH session from $p is outside $LAN"; outside=1; }; done
  [ "$outside" -eq 0 ] || [ "$FORCE" -eq 1 ] || die "an SSH session comes from outside $LAN: ufw would cut it (--lan CIDR, or --force)"
}

apply_ssh() {
  mkdir -p "$(dirname "$DROPIN")"
  local backup=""
  if [ -f "$DROPIN" ] && [ "$(cat "$DROPIN")" != "$WANT" ]; then
    backup="$DROPIN.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$DROPIN" "$backup"
  fi
  printf '%s\n' "$WANT" > "$DROPIN.tmp"
  chmod 644 "$DROPIN.tmp"
  mv "$DROPIN.tmp" "$DROPIN"
  if ! sshd -t; then
    if [ -n "$backup" ]; then mv "$backup" "$DROPIN"; else rm -f "$DROPIN"; fi
    die "sshd -t rejected the configuration: drop-in reverted, nothing restarted"
  fi
  systemctl restart ssh
  local got
  got=$(sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' | awk '{print $2}' | sort -u | tr '\n' ' ')
  [ "$got" = "no " ] || die "sshd still reports '$got' for the three settings: another file wins, see sshd -T"
  say "ok   SSH: key only, root refused (sshd restarted; open sessions stay up)"
}

apply_ufw() {
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow from "$LAN" to any port 22 proto tcp comment 'orch: ssh LAN' >/dev/null
  local pool
  for pool in $DOCKER_POOLS; do ufw allow from "$pool" comment 'orch: docker networks' >/dev/null; done
  ufw --force enable >/dev/null
  say "ok   ufw on: incoming denied but SSH from $LAN and Docker networks"
}

# The hardened sshd configuration, checked by the real sshd on a copy: the
# main file with its drop-in Include pointed at a temp dir holding the
# existing drop-ins plus ours. Nothing under /etc is written.
dry_ssh() {
  local tmp got f
  grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf\s*$' "$SSHD_MAIN" \
    || die "dry-run: $SSHD_MAIN has no 'Include /etc/ssh/sshd_config.d/*.conf': the drop-in would be ignored"
  tmp=$(mktemp -d)
  mkdir "$tmp/d"
  sed -E "s#^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf\s*\$#Include $tmp/d/*.conf#" "$SSHD_MAIN" > "$tmp/sshd_config"
  for f in "$ROOT"/etc/ssh/sshd_config.d/*.conf; do
    [ -e "$f" ] && [ "$(basename "$f")" != "$(basename "$DROPIN")" ] && cp "$f" "$tmp/d/"
  done
  printf '%s\n' "$WANT" > "$tmp/d/$(basename "$DROPIN")"
  if ! sshd -t -f "$tmp/sshd_config"; then rm -rf "$tmp"; die "dry-run: sshd -t rejects the hardened configuration"; fi
  got=$(sshd -T -f "$tmp/sshd_config" | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) ' | sort)
  rm -rf "$tmp"
  say "$got" | sed 's/^/     would be: /'
  [ "$(say "$got" | awk '{print $2}' | sort -u)" = "no" ] || die "dry-run: another sshd file would still win, see the values above"
  say "ok   SSH: sshd -t accepts the hardened configuration, the three settings would be no"
}

dry_ufw() {
  local pool
  ufw --dry-run default deny incoming >/dev/null
  ufw --dry-run default allow outgoing >/dev/null
  ufw --dry-run allow from "$LAN" to any port 22 proto tcp comment 'orch: ssh LAN' >/dev/null
  for pool in $DOCKER_POOLS; do ufw --dry-run allow from "$pool" comment 'orch: docker networks' >/dev/null; done
  say "ok   ufw: every rule accepted in dry run (deny incoming, SSH from $LAN, Docker networks; enable last)"
}

apply() {
  need_root
  if [ "$DRY" -eq 1 ]; then
    [ -n "$LAN" ] || LAN=$(detect_lan)
    local before_dropin before_ufw
    before_dropin=$(cat "$DROPIN" 2>/dev/null || true)
    before_ufw=$(cat "$UFW_CONF" 2>/dev/null || true)
    check_keys
    check_sessions
    dry_ssh
    dry_ufw
    [ "$(cat "$DROPIN" 2>/dev/null || true)" = "$before_dropin" ] && [ "$(cat "$UFW_CONF" 2>/dev/null || true)" = "$before_ufw" ] \
      || die "dry-run changed a file: report this"
    say "dry run: nothing changed; sudo $0 apply would pass"
    return
  fi
  [ -n "$LAN" ] || LAN=$(detect_lan)
  check_keys
  check_sessions
  apply_ssh
  apply_ufw
  say "next: from another terminal, ssh to this host again before closing this session; then orch ops check"
}

rollback() {
  need_root
  if [ -f "$DROPIN" ]; then
    rm -f "$DROPIN"
    sshd -t && systemctl restart ssh
    say "ok   SSH drop-in removed, sshd restarted"
  else
    say "ok   no SSH drop-in to remove"
  fi
  ufw --force disable >/dev/null
  say "ok   ufw disabled (its rules are kept; sudo ufw --force reset clears them)"
}

case "$MODE" in
  check) check ;;
  apply) apply ;;
  rollback) rollback ;;
esac
