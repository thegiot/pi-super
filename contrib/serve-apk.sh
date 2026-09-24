#!/bin/sh
# Serve the debug APK over the tailnet for 30 minutes and print a QR code for it.
#
# Why not Taildrop or adb: Taildrop to Android stalls at 0% more often than not, and adb
# needs a cable and USB debugging. A phone on the tailnet can always open a URL, and
# nobody wants to type one, hence the QR code.
#
# Usage: contrib/serve-apk.sh   (after npm run build:android)
set -eu
root=$(git rev-parse --show-toplevel)
apk="$root/android/app/build/outputs/apk/debug/app-debug.apk"
port=8765
[ -f "$apk" ] || { echo "no APK at $apk — run npm run build:android first" >&2; exit 1; }
ip=$(tailscale ip -4 | head -1)
dir=/tmp/pi-super-apk
mkdir -p "$dir"
cp "$apk" "$dir/pi-super.apk"
# a previous run still holds the port
pkill -f "http.server $port" 2>/dev/null || true
sleep 0.3
cd "$dir"
nohup timeout 1800 python3 -m http.server "$port" --bind "$ip" >"$dir/log" 2>&1 &
sleep 0.5
url="http://$ip:$port/pi-super.apk"
curl -sfI "$url" >/dev/null || { echo "server did not come up, see $dir/log" >&2; exit 1; }
echo "$url"
qrencode -t UTF8 -m 1 "$url"
