#!/bin/bash
# install.sh — 兼容入口（正式脚本在 deploy/install.sh）
#
# 2026-11 目录重排后脚本收进 deploy/，但 `./install.sh` 这个入口在文档、习惯和
# 外部脚本里到处都是：保留一个几行的转发壳，比让所有人改命令更划算。
# 用 exec 替换进程（不套一层子 shell），退出码与信号语义和直接调用完全一致。
#
# 用法: ./install.sh [端口]     # 缺省 8484
# 其它命令同理：./uninstall.sh、./status.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/deploy/install.sh" "$@"
