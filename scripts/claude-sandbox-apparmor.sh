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

# Overridable for tests (tests/apparmor.test.ts); the defaults are the system's.
APPARMOR_DIR="${APPARMOR_DIR:-/etc/apparmor.d}"
APPARMOR_PROFILES="${APPARMOR_PROFILES:-/sys/kernel/security/apparmor/profiles}"
PROFILE="$APPARMOR_DIR/bwrap"
UBUNTU="$APPARMOR_DIR/bwrap-userns-restrict"
DISABLED="$APPARMOR_DIR/disable/bwrap-userns-restrict"
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

# The profile may be root-only (older installs of this script): read it as
# root when needed; `ours prompt` may ask for the sudo password, plain `ours`
# never does.
first_line() {
  if [ -r "$PROFILE" ]; then head -n1 "$PROFILE"
  elif [ "${1:-}" = prompt ]; then sudo head -n1 "$PROFILE"
  else sudo -n head -n1 "$PROFILE" 2>/dev/null
  fi
}
ours() {
  [ -f "$PROFILE" ] || return 1
  first_line "${1:-}" | grep -qxF "$MARK"
}

loaded() { sudo grep -q "^$1 " "$APPARMOR_PROFILES"; }

# Put back the Ubuntu profile and drop ours, after a failed install.
rollback() {
  echo "install failed: $1; restoring the previous state" >&2
  if [ "$had_ours" = no ]; then
    sudo apparmor_parser -R "$PROFILE" 2>/dev/null || true
    sudo rm -f "$PROFILE"
  fi
  if [ "$had_disabled" = no ] && [ -L "$DISABLED" ]; then
    sudo rm -f "$DISABLED"
    sudo apparmor_parser -r "$UBUNTU"
  fi
  exit 1
}

install() {
  if ! restricted; then
    echo "user namespaces are not restricted by AppArmor here: nothing to change"
    probe
    return
  fi
  if [ -f "$PROFILE" ] && ! ours prompt; then
    echo "refusing: $PROFILE exists and was not written by this script" >&2
    exit 1
  fi
  had_ours=no; ours prompt && had_ours=yes
  had_disabled=no; [ -L "$DISABLED" ] && had_disabled=yes
  # Validate the replacement before touching anything (parse only, no load).
  local tmp
  tmp=$(mktemp)
  profile_body > "$tmp"
  if ! sudo apparmor_parser -Q -K "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "refusing: the replacement profile does not parse; nothing changed" >&2
    exit 1
  fi
  rm -f "$tmp"
  if [ -f "$UBUNTU" ]; then
    if loaded bwrap && [ "$had_ours" = no ]; then
      sudo apparmor_parser -R "$UBUNTU" || rollback "could not unload $UBUNTU"
    fi
    [ -L "$DISABLED" ] || sudo ln -s "$UBUNTU" "$DISABLED" || rollback "could not disable $UBUNTU"
    echo "disabled $UBUNTU"
  fi
  # Every step after the Ubuntu profile is unloaded rolls back on failure
  # (the `||` also keeps set -e from exiting before the rollback runs).
  { profile_body | sudo tee "$PROFILE" > /dev/null; } || rollback "could not write $PROFILE"
  sudo chmod 644 "$PROFILE" || rollback "could not chmod $PROFILE"
  sudo apparmor_parser -r "$PROFILE" || rollback "could not load $PROFILE"
  echo "loaded $PROFILE"
  probe || rollback "the sandbox probe still fails with the replacement profile"
}

uninstall() {
  if ours prompt; then
    if loaded bwrap; then
      sudo apparmor_parser -R "$PROFILE" || { echo "could not unload $PROFILE; nothing removed" >&2; exit 1; }
    fi
    sudo rm -f "$PROFILE"
    echo "removed $PROFILE"
  elif [ -f "$PROFILE" ]; then
    echo "kept $PROFILE: not written by this script"
  fi
  if [ -L "$DISABLED" ]; then
    sudo rm -f "$DISABLED"
    sudo apparmor_parser -r "$UBUNTU" || { echo "could not reload $UBUNTU: run sudo apparmor_parser -r $UBUNTU" >&2; exit 1; }
    echo "restored $UBUNTU"
  fi
  probe || true
}

status() {
  echo "kernel.apparmor_restrict_unprivileged_userns = $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
  if ours; then echo "$PROFILE: installed by this script"
  elif [ -f "$PROFILE" ] && [ ! -r "$PROFILE" ]; then echo "$PROFILE: present, root-only (--install or --uninstall checks it with sudo)"
  elif [ -f "$PROFILE" ]; then echo "$PROFILE: present, not written by this script"
  else echo "$PROFILE: absent"; fi
  if [ -L "$DISABLED" ]; then echo "$UBUNTU: disabled"; else echo "$UBUNTU: active"; fi
  probe
}

case "${1:-}" in
  --install) install ;;
  --uninstall) uninstall ;;
  --status) status ;;
  *) echo "usage: $0 --install | --uninstall | --status" >&2; exit 2 ;;
esac
