#!/usr/bin/env bash
# Let the Claude worker's OS sandbox run on Ubuntu 24.04 and later.
#
# Ubuntu restricts unprivileged user namespaces through AppArmor
# (kernel.apparmor_restrict_unprivileged_userns = 1). Its profile
# bwrap-userns-restrict lets bwrap create one namespace but strips the
# capabilities of everything bwrap runs, so the seccomp helper Claude Code
# starts inside the sandbox cannot open its own namespace and every
# sandboxed command fails. --install swaps that profile for the one the
# Claude Code docs give (https://code.claude.com/docs/en/sandboxing,
# "Ubuntu 24.04 and later"): bwrap unconfined, allowed to create user
# namespaces. Cost: any local process can get a user namespace through bwrap,
# as on Ubuntu before 24.04. --uninstall restores the Ubuntu profile.
#
# Usage: scripts/claude-sandbox-apparmor.sh --install | --uninstall | --status
set -euo pipefail

PROFILE=/etc/apparmor.d/bwrap
UBUNTU=/etc/apparmor.d/bwrap-userns-restrict
DISABLED=/etc/apparmor.d/disable/bwrap-userns-restrict
MARK="# Installed by orch scripts/claude-sandbox-apparmor.sh"

profile_body() {
  cat <<EOF
$MARK
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
}

restricted() {
  [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]
}

# Same checks as `orch doctor`: bwrap alone, then the nesting the sandbox needs.
probe() {
  if bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user true 2>/dev/null; then
    echo "ok   bwrap can create a user namespace"
  else
    echo "FAIL bwrap cannot create a user namespace"
  fi
  if bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user unshare --user --map-root-user true 2>/dev/null; then
    echo "ok   a user namespace can nest inside bwrap (Claude worker sandbox)"
  else
    echo "FAIL no user namespace can nest inside bwrap (Claude worker sandbox)"
    return 1
  fi
}

ours() { [ -f "$PROFILE" ] && head -n1 "$PROFILE" | grep -qxF "$MARK"; }

install() {
  if ! restricted; then
    echo "user namespaces are not restricted by AppArmor here: nothing to change"
    probe
    return
  fi
  if [ -f "$PROFILE" ] && ! ours; then
    echo "refusing: $PROFILE exists and was not written by this script" >&2
    exit 1
  fi
  if [ -f "$UBUNTU" ]; then
    sudo apparmor_parser -R "$UBUNTU" 2>/dev/null || true
    [ -L "$DISABLED" ] || sudo ln -s "$UBUNTU" "$DISABLED"
    echo "disabled $UBUNTU"
  fi
  profile_body | sudo tee "$PROFILE" > /dev/null
  sudo apparmor_parser -r "$PROFILE"
  echo "loaded $PROFILE"
  probe
}

uninstall() {
  if ours; then
    sudo apparmor_parser -R "$PROFILE" 2>/dev/null || true
    sudo rm -f "$PROFILE"
    echo "removed $PROFILE"
  elif [ -f "$PROFILE" ]; then
    echo "kept $PROFILE: not written by this script"
  fi
  if [ -L "$DISABLED" ]; then
    sudo rm -f "$DISABLED"
    sudo apparmor_parser -r "$UBUNTU"
    echo "restored $UBUNTU"
  fi
  probe || true
}

status() {
  echo "kernel.apparmor_restrict_unprivileged_userns = $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
  if ours; then echo "$PROFILE: installed by this script"; elif [ -f "$PROFILE" ]; then echo "$PROFILE: present, not ours"; else echo "$PROFILE: absent"; fi
  if [ -L "$DISABLED" ]; then echo "$UBUNTU: disabled"; else echo "$UBUNTU: active"; fi
  probe
}

case "${1:-}" in
  --install) install ;;
  --uninstall) uninstall ;;
  --status) status ;;
  *) echo "usage: $0 --install | --uninstall | --status" >&2; exit 2 ;;
esac
