#!/bin/sh
# verify 容器入口：一次性验收，退出码即验收结果
set -eu
exec node verify/verify.mjs
