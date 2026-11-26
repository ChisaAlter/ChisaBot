#!/bin/sh
# GIT_ASKPASS for chisabot-updater's GitHub fetch: the username is in the URL (x-access-token), so git only
# asks for the password, which is the read-only token in /opt/chisabot-updater/github-token (root, 600).
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
case "$1" in
  Username*) echo x-access-token ;;
  *) cat "$U/github-token" ;;
esac
