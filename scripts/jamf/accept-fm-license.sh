#!/bin/bash
# accept-fm-license.sh — Jamf policy script (run as root, once per Mac).
#
# Only needed for GrowthOS builds WITHOUT the bundled Apple helper
# (york-apple-llm). Current builds use the FoundationModels framework
# directly and never need this. For older fm-CLI builds: `fm` refuses to
# run until a privileged user accepts the Apple Foundation Models CLI
# terms, recorded machine-wide in /Library/Preferences/com.apple.fm.plist.
# Jamf policies already run as root, so IT can accept once for everyone —
# employees never need sudo.
#
# Jamf setup: Policies → [macOS 26+ fleet] → Scripts → this file,
# trigger: once per computer (or ongoing at check-in until exit 0).
# Legal note: this accepts Apple's CLI terms on behalf of the machine's
# owner. Have IT/legal approve before deploying.

set -u

LOG_TAG="[york-fm-license]"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "$LOG_TAG Must run as root (Jamf policies do). Exiting."
  exit 1
fi

if [[ ! -x /usr/bin/fm ]]; then
  echo "$LOG_TAG /usr/bin/fm not found — needs macOS 26+ with the fm CLI. Nothing to do."
  exit 0
fi

status_out="$(/usr/bin/fm license --status 2>&1)"
if echo "$status_out" | grep -qi "^Agreed\|already agreed\|You have agreed"; then
  echo "$LOG_TAG Already agreed: $status_out"
  exit 0
fi

# `fm license` presents the terms on a TTY and reads 'yes' from it.
# Jamf has no TTY, so allocate a pty with `script` and feed the answer.
echo "$LOG_TAG Accepting Apple Foundation Models CLI terms via pty…"
printf 'yes\n' | /usr/bin/script -q /dev/null /usr/bin/fm license >/dev/null 2>&1

status_out="$(/usr/bin/fm license --status 2>&1)"
if echo "$status_out" | grep -qi "not agreed"; then
  echo "$LOG_TAG FAILED — still not agreed: $status_out"
  exit 1
fi

available_out="$(/usr/bin/fm available --model system 2>&1 | head -n 1)"
echo "$LOG_TAG Agreed. Model check: $available_out"
exit 0
