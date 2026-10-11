#!/usr/bin/env bash

# the installation is done in subshell to prefent set -euo pipefail affecting the host-shell when this script is sourced

timelens_install() (
    set -euo pipefail

    REPOSITORY="https://github.com/CobaltFusion/timelens.git"
    LOG_DIR="/tmp/logs/telemetry"
    target_user="$(id -un)"
    install_dir=""

    usage() {
        echo "Usage: $0 [-u user] [-i install_dir]" >&2
    }

    while getopts ":u:i:" opt; do
        case "$opt" in
            u)
                if [[ ${EUID} -ne 0 ]]; then
                    echo "Error: -u requires root." >&2
                    exit 2
                fi
                target_user="$OPTARG"
                ;;
            i)
                if [[ -z "$OPTARG" ]]; then
                    echo "Error: install directory cannot be empty." >&2
                    exit 2
                fi
                install_dir="$OPTARG"
                ;;
            :)
                echo "Error: option -$OPTARG requires an argument." >&2
                usage
                exit 2
                ;;
            \?)
                echo "Error: unknown option -$OPTARG." >&2
                usage
                exit 2
                ;;
        esac
    done

    shift "$((OPTIND - 1))"

    if [[ $# -ne 0 ]]; then
        usage
        exit 2
    fi

    if [[ ${EUID} -eq 0 ]]; then
        if ! id "$target_user" >/dev/null 2>&1; then
            echo "Error: user '$target_user' does not exist." >&2
            exit 1
        fi

        target_group="$(id -gn "$target_user")"

        if [[ -z "$install_dir" ]]; then
            install_dir="/var/timelens"
        fi
    else
        if [[ "$target_user" != "$(id -un)" ]]; then
            echo "Error: -u requires root." >&2
            exit 2
        fi

        if [[ -z "$install_dir" ]]; then
            install_dir="/tmp/timelens"
        fi
    fi

    if [[ -e "$install_dir" ]]; then
        echo "Error: installation directory already exists: $install_dir" >&2
        exit 1
    fi

    if ! command -v git >/dev/null 2>&1; then
        echo "Error: git is required but was not found." >&2
        exit 1
    fi

    echo "Cloning TimeLens into $install_dir..."
    git clone "$REPOSITORY" "$install_dir"

    if [[ ${EUID} -eq 0 ]]; then
        echo "Setting ownership of $install_dir to $target_user:$target_group..."
        chown -R "$target_user:$target_group" "$install_dir"

        echo "Creating telemetry log directory..."
        install -d -o "$target_user" -g "$target_group" -m 700 "$LOG_DIR"
    else
        echo "Creating telemetry log directory..."
        mkdir -p "$LOG_DIR"
    fi

    start_script="$install_dir/start_timelens.sh"

    if [[ ! -f "$start_script" ]]; then
        echo "Error: startup script not found: $start_script" >&2
        exit 1
    fi

    if [[ ! -x "$start_script" ]]; then
        echo "Error: startup script is not executable: $start_script" >&2
        exit 1
    fi

    echo "Starting TimeLens..."
    cd "$install_dir"

    if [[ ${EUID} -eq 0 ]]; then
        runuser -u "$target_user" -- "$start_script"
    else
        "$start_script"
    fi
)

timelens_install "$@"
