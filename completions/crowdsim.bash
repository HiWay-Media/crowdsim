# bash completion for crowdsim — install: source this file, or drop it in
# /usr/share/bash-completion/completions/crowdsim (see docs/install.md).
#
# It reads the crowdsim script's own comment header for the subcommand list and for each subcommand's
# flags, so it cannot go stale: the header IS the help text, and a completion carrying its own copy of a
# flag list is a copy that silently hides the next flag somebody adds.
#
# It never RUNS crowdsim. Reading a file is free; a completion that shells out to this tool is a
# completion that can generate load, and it would do so from a keystroke.

_crowdsim_script() {
  local p
  p="$(command -v crowdsim 2>/dev/null)" || return 1
  [ -r "$p" ] && printf '%s' "$p"
}

_crowdsim_subcommands() {
  local s; s="$(_crowdsim_script)" || return 0
  sed -n 's/^#@ \([a-z-][a-z-]*\)$/\1/p' "$s"
}

# Every long flag named inside one subcommand's block, including in its prose: a flag mentioned in the
# description of another is still a flag that subcommand understands.
_crowdsim_flags() {
  local s; s="$(_crowdsim_script)" || return 0
  awk -v want="$1" '
    $0 == "#@ " want { inblock = 1; next }
    /^#@/ && inblock  { exit }
    inblock           { print }
  ' "$s" | grep -oE -- '--[a-z0-9][a-z0-9-]*' | sort -u
}

_crowdsim_runs() {
  local f="${CROWDSIM_OUT:-$PWD/out}/history.tsv"
  [ -r "$f" ] || return 0
  # header-keyed everywhere else, and the run id is the first column; `latest` and `previous` are
  # completable too, because they are accepted wherever a run id is.
  awk 'NR > 1 { print $1 }' "$f" | tac 2>/dev/null || awk 'NR > 1 { print $1 }' "$f"
}

_crowdsim_profiles() {
  local d="${CROWDSIM_PROFILES:-$PWD/profiles}"
  [ -d "$d" ] || return 0
  ls -1 "$d"/*.json 2>/dev/null
}

_crowdsim() {
  local cur prev cmd i
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  for ((i = 1; i < COMP_CWORD; i++)); do
    case "${COMP_WORDS[i]}" in
      -*) ;;
      *) cmd="${COMP_WORDS[i]}"; break;;
    esac
  done

  if [ -z "$cmd" ]; then
    COMPREPLY=($(compgen -W "$(_crowdsim_subcommands) --help --version" -- "$cur"))
    return 0
  fi

  case "$prev" in
    --profile)
      COMPREPLY=($(compgen -W "$(_crowdsim_profiles)" -- "$cur"))
      COMPREPLY+=($(compgen -f -- "$cur")); return 0;;
    --compare)
      COMPREPLY=($(compgen -W "latest previous $(_crowdsim_runs)" -- "$cur")); return 0;;
    --out|--access-log|--third|--new-leg)
      COMPREPLY=($(compgen -f -- "$cur")); return 0;;
    --shape)    COMPREPLY=($(compgen -W "mix journey" -- "$cur")); return 0;;
    --rsc-mode) COMPREPLY=($(compgen -W "repeat random" -- "$cur")); return 0;;
  esac

  if [[ "$cur" == -* ]]; then
    # --i-know-this-breaks-production completes like anything else. Hiding it would not make anybody
    # safer; it would only make the gate look like a secret instead of a decision somebody takes.
    COMPREPLY=($(compgen -W "$(_crowdsim_flags "$cmd") --help" -- "$cur")); return 0
  fi

  case "$cmd" in
    report|compare) COMPREPLY=($(compgen -W "latest previous $(_crowdsim_runs)" -- "$cur"));;
    validate|record|weights) COMPREPLY=($(compgen -f -- "$cur"));;
    *) COMPREPLY=();;
  esac
}

complete -F _crowdsim crowdsim
