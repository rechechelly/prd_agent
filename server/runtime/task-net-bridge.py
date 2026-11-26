"""Connect the Linux task's private loopback interface to its host-side proxy."""
import os
import selectors
import socket
import socketserver
import sys
import threading
import subprocess

class Tunnel(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.socket(socket.AF_UNIX) as upstream, selectors.DefaultSelector() as poll:
            upstream.connect(sys.argv[1])
            poll.register(upstream, selectors.EVENT_READ, self.request)
            poll.register(self.request, selectors.EVENT_READ, upstream)
            while True:
                for event, _ in poll.select():
                    chunk = event.fileobj.recv(65536)
                    if not chunk:
                        return
                    event.data.sendall(chunk)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", int(os.environ["TASK_PROXY_PORT"])), Tunnel) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    sys.exit(subprocess.call(["/bin/bash", *sys.argv[2:]]))
