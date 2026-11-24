import Foundation

/// Pulse's prompt for terminal tabs: zsh's prompt drawn as the input box of the welcome card,
///
///     ╭─ ~/dev/pulse · ⎇ main ─────────────────────╮
///     │ ❯ Try "pnpm run dev"                        │   ← typing happens here; the grey hint goes as you type
///     ╰─────────────────────────────────────────────╯
///
/// as wide as the card (the pane less 2, at most 100). It is added the way VS Code and Ghostty add their shell
/// integration: zsh starts with ZDOTDIR pointing at Pulse's files, which load the user's own (.zshenv, .zprofile, .zshrc,
/// .zlogin) first and give ZDOTDIR back. It only takes over a prompt that is still macOS's default: a prompt of the user's
/// own (starship, powerlevel10k, oh-my-zsh, a PS1) is left alone. PULSE_PROMPT=0 turns it off.
public enum ShellIntegration {
    /// macOS's default zsh prompt (/etc/zshrc).
    public static let defaultZshPrompt = "%n@%m %1~ %# "

    /// The files of Pulse's ZDOTDIR, by name.
    public static func zshFiles() -> [String: String] {
        // each startup file loads the user's own from their ZDOTDIR (or home), with ZDOTDIR set to theirs meanwhile
        func relay(_ name: String) -> String {
            """
            # Pulse Explorer: the user's own \(name) first (written by Pulse, rewritten on each start)
            _pulse_zd="$ZDOTDIR"
            ZDOTDIR="${PULSE_USER_ZDOTDIR:-$HOME}"
            [[ -r "$ZDOTDIR/\(name)" ]] && builtin source "$ZDOTDIR/\(name)"
            PULSE_USER_ZDOTDIR="$ZDOTDIR"
            ZDOTDIR="$_pulse_zd"
            unset _pulse_zd

            """
        }
        return [
            ".zshenv": relay(".zshenv"),
            ".zprofile": relay(".zprofile"),
            ".zshrc": relay(".zshrc") + prompt,
            // the last file: ZDOTDIR is the user's again for everything started from this shell
            ".zlogin": relay(".zlogin") + "ZDOTDIR=\"$PULSE_USER_ZDOTDIR\"\n",
        ]
    }

    /// Writes the files into `dir` (made if needed); returns it.
    @discardableResult
    public static func install(in dir: URL) throws -> URL {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, text) in zshFiles() {
            try text.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        return dir
    }

    /// The prompt itself (zsh): built before each prompt for the pane's width, with the folder and branch in the box's top
    /// edge, a right edge that follows the typing, the hint while the line is empty, and the bottom edge under it.
    static let prompt = #"""

    # Pulse Explorer's prompt: the welcome card's input box
    if [[ "${PULSE_PROMPT:-1}" != 0 && ( "$PROMPT" == '%n@%m %1~ %# ' || -z "$PROMPT" ) ]]; then
      autoload -Uz add-zsh-hook add-zle-hook-widget 2>/dev/null
      typeset -g PULSE_W=80 _pulse_bc='#4a4a47' _pulse_tc='#c8c8c2' _pulse_hc='#7c7c79'
      typeset -gi _pulse_suggest=0
      (( ${+functions[_zsh_autosuggest_start]} )) && _pulse_suggest=1

      _pulse_precmd() {
        local w=$(( COLUMNS - 2 )); (( w > 100 )) && w=100; (( w < 24 )) && w=24
        PULSE_W=$w
        local place="${(%):-%~}" branch=""
        branch=$(command git symbolic-ref --short -q HEAD 2>/dev/null || command git rev-parse --short HEAD 2>/dev/null)
        local head=" $place"; [[ -n $branch ]] && head+=" · ⎇ $branch"; head+=" "
        (( ${#head} > w - 4 )) && head=" …${head: -$(( w - 6 ))}"
        local fill=$(( w - 3 - ${#head} )); (( fill < 0 )) && fill=0
        local line=${(l:$fill::─:)}
        PROMPT="%F{$_pulse_bc}╭─%f%F{$_pulse_tc}${head//\%/%%}%f%F{$_pulse_bc}${line}╮%f"$'\n'"%F{$_pulse_bc}│%f %B❯%b "
      }

      # the hint and the right edge after what is typed, the bottom edge under the line
      # after what is typed: the hint (while the line is empty), the right edge, and on the next line the bottom edge,
      # all in the box's colours (POSTDISPLAY with region_highlight; zle -M could not be coloured)
      _pulse_line() {
        (( _pulse_suggest )) && return
        local room=$(( PULSE_W - 5 - ${#BUFFER} ))
        local bottom=$'\n'"╰${(l:$(( PULSE_W - 2 ))::─:)}╯"
        region_highlight=( ${region_highlight:#*pulse*} )
        local b=${#BUFFER}
        if [[ $BUFFER == *$'\n'* ]] || (( room < 0 )); then
          POSTDISPLAY="$bottom"
          region_highlight+=( "$b $(( b + ${#POSTDISPLAY} )) fg=$_pulse_bc,memo=pulse" )
        else
          local hint=""
          [[ -z $BUFFER && -n $PULSE_TRY ]] && hint="Try \"$PULSE_TRY\""
          (( ${#hint} > room )) && hint=""
          POSTDISPLAY="$hint${(l:$(( room - ${#hint} )):: :)}│$bottom"
          (( ${#hint} )) && region_highlight+=( "$b $(( b + ${#hint} )) fg=$_pulse_hc,memo=pulse" )
          region_highlight+=( "$(( b + room )) $(( b + ${#POSTDISPLAY} )) fg=$_pulse_bc,memo=pulse" )
        fi
      }
      _pulse_line_init() { _pulse_line }
      # Return: the line is redrawn without what follows it (the box is closed by preexec, below the command)
      _pulse_line_finish() {
        POSTDISPLAY=""
        region_highlight=( ${region_highlight:#*pulse*} )
        zle -R
      }
      # coding agents (Claude Code, Antigravity, Codex, Gemini, …) draw their own interface: before one starts, Pulse's
      # card and box leave the screen; PULSE_EXTRA_AGENTS adds names
      typeset -ga PULSE_AGENTS=( claude claude-code agy antigravity codex gemini aider opencode amp cursor-agent goose crush qwen droid copilot ${=PULSE_EXTRA_AGENTS} )
      _pulse_is_agent() {
        local -a w=( ${(z)1} )
        local -i i=1
        while (( i <= $#w )); do
          case ${w[i]} in
            *=*|env|command|builtin|exec|nocorrect|noglob|time|nohup|caffeinate|-*) (( i++ )) ;;
            npx|bunx|pnpx|uvx|pipx) (( i++ )); [[ ${w[i]} == run ]] && (( i++ )) ;;
            pnpm|yarn|bun|npm) if [[ ${w[i+1]} == (dlx|x|exec) ]]; then (( i += 2 )); else break; fi ;;
            *) break ;;
          esac
        done
        (( i > $#w )) && return 1
        local cmd=${${w[i]:t}%%@*}
        [[ -z $cmd ]] && cmd=${${w[i]#@*/}%%@*}
        [[ $cmd == *-cli ]] && cmd=${cmd%-cli}
        (( ${PULSE_AGENTS[(Ie)$cmd]} ))
      }

      # once a command runs: the hint is not offered again, the box is closed in the scrollback; an agent gets a clean screen
      _pulse_preexec() {
        PULSE_TRY=""
        if _pulse_is_agent "${3:-$1}"; then
          print -n $'\e[H\e[2J'
          return
        fi
        print -P "%F{$_pulse_bc}╰${(l:$(( PULSE_W - 2 ))::─:)}╯%f"
      }

      add-zsh-hook precmd _pulse_precmd
      add-zsh-hook preexec _pulse_preexec
      add-zle-hook-widget line-init _pulse_line_init
      add-zle-hook-widget line-finish _pulse_line_finish
      add-zle-hook-widget line-pre-redraw _pulse_line
      RPROMPT=""
      typeset -g PULSE_PROMPT_ACTIVE=1
    fi

    """#
}
