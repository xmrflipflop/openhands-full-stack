default:
    @just --list

dev *args:
    ./scripts/dev-local.sh {{args}}
