import { Command } from "commander";

export function registerCompletionCommand(program: Command): void {
  const completion = program.command("completion").description("Generate shell completions");

  completion
    .command("bash")
    .description("Output bash completions")
    .action(() => {
      const script = generateBashCompletion();
      process.stdout.write(script);
    });

  completion
    .command("zsh")
    .description("Output zsh completions")
    .action(() => {
      const script = generateZshCompletion();
      process.stdout.write(script);
    });

  completion
    .command("fish")
    .description("Output fish completions")
    .action(() => {
      const script = generateFishCompletion();
      process.stdout.write(script);
    });
}

function generateBashCompletion(): string {
  return `# tc bash completion
_tc_completions() {
  local cur prev commands subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="init auth kv space delegation share node profile completion"

  case "\${COMP_WORDS[1]}" in
    auth) subcommands="login logout rotate status whoami" ;;
    kv) subcommands="get put delete list head" ;;
    space) subcommands="list create info switch" ;;
    delegation) subcommands="create list info revoke" ;;
    share) subcommands="create receive list revoke" ;;
    node) subcommands="health version status" ;;
    profile) subcommands="list create show switch delete" ;;
    completion) subcommands="bash zsh fish" ;;
    *) COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") ); return ;;
  esac

  if [ \${COMP_CWORD} -eq 2 ]; then
    COMPREPLY=( $(compgen -W "\${subcommands}" -- "\${cur}") )
  fi
}
complete -F _tc_completions tc
`;
}

function generateZshCompletion(): string {
  return `#compdef tc

_tc() {
  local -a commands
  commands=(
    'init:Initialize a new TinyCloud profile'
    'auth:Authentication management'
    'kv:Key-value store operations'
    'space:Space management'
    'delegation:Manage delegations'
    'share:Share data with others'
    'node:Node health and info'
    'profile:Profile management'
    'completion:Generate shell completions'
  )

  _arguments -C \\
    '(-p --profile)'{-p,--profile}'[Profile to use]:profile:' \\
    '(-H --host)'{-H,--host}'[TinyCloud node URL]:url:' \\
    '(-v --verbose)'{-v,--verbose}'[Enable verbose output]' \\
    '--no-cache[Disable caching]' \\
    '(-q --quiet)'{-q,--quiet}'[Suppress non-essential output]' \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        auth) _values 'subcommand' login logout rotate status whoami ;;
        kv) _values 'subcommand' get put delete list head ;;
        space) _values 'subcommand' list create info switch ;;
        delegation) _values 'subcommand' create list info revoke ;;
        share) _values 'subcommand' create receive list revoke ;;
        node) _values 'subcommand' health version status ;;
        profile) _values 'subcommand' list create show switch delete ;;
        completion) _values 'subcommand' bash zsh fish ;;
      esac
      ;;
  esac
}

_tc
`;
}

function generateFishCompletion(): string {
  return `# tc fish completion
set -l commands init auth kv space delegation share node profile completion

# Disable file completion by default
complete -c tc -f

# Top-level commands
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a init -d "Initialize a new TinyCloud profile"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a auth -d "Authentication management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a kv -d "Key-value store operations"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a space -d "Space management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a delegation -d "Manage delegations"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a share -d "Share data with others"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a node -d "Node health and info"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a profile -d "Profile management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a completion -d "Generate shell completions"

# Subcommands
complete -c tc -n "__fish_seen_subcommand_from auth" -a "login logout rotate status whoami"
complete -c tc -n "__fish_seen_subcommand_from kv" -a "get put delete list head"
complete -c tc -n "__fish_seen_subcommand_from space" -a "list create info switch"
complete -c tc -n "__fish_seen_subcommand_from delegation" -a "create list info revoke"
complete -c tc -n "__fish_seen_subcommand_from share" -a "create receive list revoke"
complete -c tc -n "__fish_seen_subcommand_from node" -a "health version status"
complete -c tc -n "__fish_seen_subcommand_from profile" -a "list create show switch delete"
complete -c tc -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"

# Global options
complete -c tc -l profile -s p -d "Profile to use"
complete -c tc -l host -s H -d "TinyCloud node URL"
complete -c tc -l verbose -s v -d "Enable verbose output"
complete -c tc -l no-cache -d "Disable caching"
complete -c tc -l quiet -s q -d "Suppress non-essential output"
`;
}
