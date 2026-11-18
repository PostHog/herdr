#!/bin/zsh
# Re-link the sections' code into this mod (Herdr won't load modules from outside a
# mod's folder, and symlinks resolve outside). Hard links keep one copy of each file;
# an editor that saves by replacing a file breaks its link, so run this after editing
# any of the section mods' .js files. tests/ella-sidebar.test.mjs fails while any copy has drifted.
set -e
M=${0:A:h}
typeset -A SRC
SRC=(ella-spaces ella-spaces accounts ella-accounts ella-agents ella-agents pond ella-pond todo ella-todo)
for m src in ${(kv)SRC}; do
  mkdir -p $M/sections/$m
  rm -f $M/sections/$m/*.js(N)
  for f in $M/../$src/*.js(N); do ln -f $f $M/sections/$m/${f:t}; done
done
echo "linked: $(ls $M/sections/*/*.js | wc -l | tr -d ' ') files"
