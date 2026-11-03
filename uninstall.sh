#!/bin/bash
# uninstall.sh — 兼容入口（正式脚本在 deploy/uninstall.sh）

DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/deploy/uninstall.sh" "$@"
