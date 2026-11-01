#!/usr/bin/env bash
# 更新所有 ?v= 版本號，讓 GitHub Pages 的瀏覽器快取失效。推上 GitHub 前執行：./bump-version.sh
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i -E "s#(common\.js|style\.css)\?v=[0-9]+#\1?v=$V#g" *.html
sed -i -E "s#^const ASSET_VERSION = '[0-9]+';#const ASSET_VERSION = '$V';#" common.js
echo "版本號已更新為 $V"
