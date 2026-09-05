#compdef crowdsim
#
# zsh completion for crowdsim — install: put this file in a directory on $fpath as `_crowdsim`
# (see docs/install.md).
#
# Same rule as the bash version: it reads the crowdsim script's own comment header for subcommands and
# flags, and never RUNS crowdsim. A completion that shells out to this tool is a completion that can
# generate load from a keystroke.

_crowdsim_script() {
  local p
  p=${commands[crowdsim]}
  [[ -r $p ]] && print -r -- $p
}

_crowdsim_subcommands() {
  local s; s=$(_crowdsim_script) || return
  sed -n 's/^#@ \([a-z-][a-z-]*\)$/\1/p' $s
}

_crowdsim_flags() {
  local s; s=$(_crowdsim_script) || return
  awk -v want="$1" '
    $0 == "#@ " want { inblock = 1; next }
    /^#@/ && inblock  { exit }
    inblock           { print }
  ' $s | grep -oE -- '--[a-z0-9][a-z0-9-]*' | sort -u
}

_crowdsim_runs() {
  local f=${CROWDSIM_OUT:-$PWD/out}/history.tsv
  [[ -r $f ]] || return
  awk 'NR > 1 { print $1 }' $f | tail -r 2>/dev/null || awk 'NR > 1 { print $1 }' $f
}

_crowdsim_profiles() {
  local d=${CROWDSIM_PROFILES:-$PWD/profiles}
  [[ -d $d ]] || return
  print -l -- $d/*.json(N)
}

_crowdsim() {
  local -a subs flags runs
  local cmd i

  for (( i = 2; i < CURRENT; i++ )); do
    [[ ${words[i]} == -* ]] && continue
    cmd=${words[i]}; break
  done

  if [[ -z $cmd ]]; then
    subs=(${(f)"$(_crowdsim_subcommands)"})
    _describe -t commands 'crowdsim subcommand' subs
    _values 'global' '--help' '--version'
    return
  fi

  case ${words[CURRENT-1]} in
    --profile)   _files -g '*.json'; compadd -- ${(f)"$(_crowdsim_profiles)"}; return;;
    --compare)   compadd -- latest previous ${(f)"$(_crowdsim_runs)"}; return;;
    --out|--access-log|--third|--new-leg) _files; return;;
    --shape)     compadd -- mix journey; return;;
    --rsc-mode)  compadd -- repeat random; return;;
  esac

  if [[ ${words[CURRENT]} == -* ]]; then
    # --i-know-this-breaks-production is completable like any other flag: a gate is a decision, not a
    # secret, and hiding it would make nobody safer.
    flags=(${(f)"$(_crowdsim_flags $cmd)"})
    compadd -- $flags --help
    return
  fi

  case $cmd in
    report|compare) compadd -- latest previous ${(f)"$(_crowdsim_runs)"};;
    validate|record|weights) _files;;
  esac
}

_crowdsim "$@"
