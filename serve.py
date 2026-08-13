#!/usr/bin/env python3
# 五子棋 + Hy3 本地代理
# 作用：
#   1) 在 http://127.0.0.1:8080 同源托管本目录的静态页面（index.html 等）
#   2) 把 /v1/* 反向代理到腾讯云 TokenHub（https://tokenhub.tencentmaas.com/v1/*）
#      —— 浏览器从同源页面发起请求不再触发 CORS 预检失败，真实 Hy3 才能被调到。
# 使用：
#   1) 终端运行：python serve.py
#   2) 浏览器打开：http://127.0.0.1:8080/
#   3) 设置里填 TokenHub 的 API Key（存浏览器 localStorage，不离开本机）
#   4) 接入方选「本地代理（serve.py）」，保存后即可用真 Hy3 对弈
# 注意：key 仍由前端提供，本脚本只做转发，不存储任何密钥。

import http.server
import socketserver
import urllib.request
import urllib.error
import json
import os
import sys

PORT = int(os.environ.get("PORT", "9000"))
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = HERE  # serve.py 与 index.html 同目录
UPSTREAM = "https://tokenhub.tencentmaas.com"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/v1/"):
            self._proxy("POST")
            return
        self.send_error(405)

    def do_GET(self):
        if self.path.startswith("/v1/"):
            self._proxy("GET")
            return
        path = self.path.split("?", 1)[0]
        if path in ("/", ""):
            path = "/index.html"
        fpath = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not fpath.startswith(STATIC_DIR) or not os.path.isfile(fpath):
            sys.stderr.write("STATIC 404 %s\n" % fpath); sys.stderr.flush()
            self.send_error(404)
            return
        ctype = self.guess_type(fpath)
        data = open(fpath, "rb").read()
        sys.stderr.write("STATIC 200 %s %d bytes\n" % (fpath, len(data))); sys.stderr.flush()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    def _proxy(self, method):
        upstream_url = UPSTREAM + self.path
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(upstream_url, data=body, method=method)
        for h in ("Authorization", "Content-Type"):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            resp = urllib.request.urlopen(req, timeout=180)
            self.send_response(resp.status)
            ct = resp.headers.get("Content-Type", "application/json")
            self.send_header("Content-Type", ct)
            self._cors()
            self.end_headers()
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(payload)
            except Exception:
                pass
        except Exception as e:
            msg = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(msg)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stderr.flush()


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = None
    bound = None
    # 端口被占用时自动顺延，避免一启动就崩
    for p in range(PORT, PORT + 10):
        try:
            httpd = socketserver.ThreadingTCPServer(("127.0.0.1", p), Handler)
            bound = p
            break
        except OSError:
            sys.stderr.write("端口 %d 被占用，尝试下一个\n" % p)
            sys.stderr.flush()
            continue
    if httpd is None:
        sys.stderr.write("无法在 %d~%d 绑定端口，可能被其他程序占满\n" % (PORT, PORT + 9))
        sys.stderr.flush()
        sys.exit(1)
    with httpd:
        print("五子棋 + Hy3 本地代理已启动")
        print("  页面：  http://127.0.0.1:%d/" % bound)
        print("  代理：  /v1/* -> %s/v1/*" % UPSTREAM)
        print("  停止：  Ctrl+C")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
