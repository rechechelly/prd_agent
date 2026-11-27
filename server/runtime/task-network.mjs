import http from "node:http";
import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fault } from "../storage.mjs";

const privateRanges = new net.BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  privateRanges.addSubnet(ip, bits);

async function publicAddress(hostname) {
  const { address } = await lookup(hostname, { family: 4 });
  if (!privateRanges.check(address)) return address;
  // Retry public package registries over authenticated DNS if split DNS supplies a private address.
  if (["pypi.org", "files.pythonhosted.org"].includes(hostname)) {
    const result = await fetch(
      "https://1.1.1.1/dns-query?type=A&name=" + hostname,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (result.ok) {
      const records = (await result.json()).Answer || [];
      const publicRecord = records.find(
        (r) =>
          r.type === 1 && net.isIPv4(r.data) && !privateRanges.check(r.data),
      );
      if (publicRecord) return publicRecord.data;
    }
  }
  throw Error("HTTPS download requires a public address");
}

function provider(input) {
  if (!input) return;
  let url;
  try {
    url = new URL(input.base);
  } catch {
    fault("外部 API 的 Base URL 无效");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    fault("外部 API 需要 HTTPS 地址；本机测试可使用 HTTP");
  if (
    typeof input.key !== "string" ||
    !input.key.trim() ||
    /[\r\n]/.test(input.key) ||
    input.key.length > 8192
  )
    fault("外部 API 的密钥无效");
  try {
    http.validateHeaderValue("authorization", "Bearer " + input.key.trim());
  } catch {
    fault("外部 API 的密钥包含无效字符");
  }
  return { url, key: input.key.trim() };
}

// Only the owner-supplied endpoint receives the credential. The task sees a short-lived local URL.
export async function openTaskNetwork(stage, input) {
  const api = provider(input);
  const token = randomBytes(24).toString("hex");
  const prefix = "/api/" + token;
  const proxyAuth = "Basic " + Buffer.from("task:" + token).toString("base64");
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const requested = req.url || "/";
    if (
      !api ||
      !(
        requested === prefix ||
        requested.startsWith(prefix + "/") ||
        requested.startsWith(prefix + "?")
      )
    ) {
      res.writeHead(403);
      return res.end("Use HTTPS for downloads or the configured task API URL.");
    }
    const dest = new URL(api.url);
    const tail = new URL("http://task.invalid" + requested);
    dest.pathname =
      api.url.pathname.replace(/\/$/, "") + tail.pathname.slice(prefix.length);
    dest.search = tail.search;
    const headers = { authorization: "Bearer " + api.key };
    for (const name of ["content-type", "content-length", "accept"])
      if (req.headers[name]) headers[name] = req.headers[name];
    const outbound = (dest.protocol === "https:" ? https : http).request(
      dest,
      { method: req.method, headers },
      (upstream) => {
        res.writeHead(upstream.statusCode, {
          "Content-Type":
            upstream.headers["content-type"] || "application/octet-stream",
          ...(upstream.headers.location && {
            Location: upstream.headers.location,
          }),
        });
        upstream.on("error", () => res.destroy());
        upstream.pipe(res);
      },
    );
    outbound.setTimeout(180000, () => outbound.destroy(Error("timeout")));
    outbound.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Upstream API request failed");
    });
    res.on("close", () => outbound.destroy());
    req.pipe(outbound);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", async (req, client, head) => {
    let remote;
    client.on("error", () => client.destroy());
    try {
      if (req.headers["proxy-authorization"] !== proxyAuth) throw Error();
      const target = new URL("https://" + req.url);
      if (
        (target.port && target.port !== "443") ||
        target.username ||
        target.password ||
        target.pathname !== "/"
      )
        throw Error();
      const address = await publicAddress(target.hostname);
      if (privateRanges.check(address) || client.destroyed) throw Error();
      remote = net.connect(443, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  const isLinux = process.platform === "linux";
  // A crashed worker can leave its Unix socket on disk. A resumed task keeps
  // the same staging area and opens a fresh listener for this attempt.
  const socketPath = path.join(stage, "inputs", "n-" + token.slice(0, 8));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (isLinux)
      server.listen(socketPath, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  const port = isLinux ? 18745 : server.address().port;
  const address = "127.0.0.1:" + port;
  const proxy = "http://task:" + token + "@" + address;
  return {
    vars: {
      TASK_PROXY_PORT: String(port),
      ...(isLinux && { TASK_PROXY_SOCKET: socketPath }),
      https_proxy: proxy,
      HTTPS_PROXY: proxy,
      no_proxy: "127.0.0.1,localhost",
      NO_PROXY: "127.0.0.1,localhost",
      ...(api && { TASK_API_BASE_URL: "http://" + address + prefix }),
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
