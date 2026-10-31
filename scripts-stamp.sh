#!/bin/sh
# Stamp asset URLs with the current commit so browsers never keep an old app.js / styles.css after a deploy.
# Run before committing a release: sh scripts-stamp.sh
V=$(git rev-parse --short HEAD)
for f in index.html checklist.html; do
  sed -i.bak -E "s#(styles\.css|xlsx-lite\.js|app\.js)(\?v=[0-9a-f]+)?\"#\1?v=$V\"#g" "$f" && rm -f "$f.bak"
done
grep -n '?v=' index.html checklist.html
