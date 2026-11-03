#!/bin/bash
# status.sh — 兼容入口（正式脚本在 deploy/status.sh）

DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/deploy/status.sh" "$@"
