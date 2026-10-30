#!/bin/bash
# Run manually as root from the uploaded, reviewed deployment bundle.
set -Eeuo pipefail
if [[ "$EUID" -ne 0 ]]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi
bundle="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test -f "$bundle/release_deploy.py"
test -f "$bundle/Dockerfile"
test -f "$bundle/start.sh"
id campus-runner >/dev/null
id campus-deploy >/dev/null
test -d /opt/campus-inspection/source/.git
test -d /opt/campus-inspection/data
test ! -L /opt/campus-inspection/data
command -v docker >/dev/null
command -v visudo >/dev/null
test -x /opt/campus-runner/externals/node24/bin/node
/usr/bin/python3 -I -c 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$bundle/release_deploy.py"
bash -n "$bundle/start.sh"
# Make privileged deployment state non-writable by either service account.
chown root:root /opt/campus-inspection
chmod 755 /opt/campus-inspection
install -d -o root -g root -m 755 /usr/local/lib/campus-inspection \
  /opt/campus-inspection/control /opt/campus-inspection/release-builds
install -d -o root -g root -m 700 /opt/campus-inspection/backups
install -o root -g root -m 755 "$bundle/release_deploy.py" /usr/local/sbin/campus-release-deploy
install -o root -g root -m 644 "$bundle/Dockerfile" /usr/local/lib/campus-inspection/Dockerfile
install -o root -g root -m 644 "$bundle/start.sh" /usr/local/lib/campus-inspection/start.sh
sudoers_tmp="$(mktemp /etc/sudoers.d/.campus-release.XXXXXX)"
trap 'rm -f -- "$sudoers_tmp"' EXIT
printf '%s\n' 'campus-runner ALL=(root) NOPASSWD: /usr/local/sbin/campus-release-deploy *' > "$sudoers_tmp"
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp"
install -o root -g root -m 440 "$sudoers_tmp" /etc/sudoers.d/campus-release
visudo -c
printf 'CAMPUS_RELEASE_ENTRYPOINT_READY\n'
printf 'No container was restarted. Publish only after committing the workflow and maintenance guard.\n'
