"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const {
  parseProxyList,
  describeProxy,
  openTunnel,
  createProxyAgent,
  createAgentFetch,
} = require("../src/agent/proxy");

test("parseProxyList parses optional credentials, URL-decodes them, and handles IPv6", () => {
  assert.deepEqual(
    parseProxyList("PROXY alice%40corp:p%40ss%3A1@127.0.0.1:7890; DIRECT"),
    [
      {
        type: "http",
        host: "127.0.0.1",
        port: 7890,
        username: "alice@corp",
        password: "p@ss:1",
      },
      { type: "direct" },
    ],
  );
  assert.deepEqual(parseProxyList("SOCKS5 bob:secret@[::1]:1080"), [
    {
      type: "socks5",
      host: "::1",
      port: 1080,
      username: "bob",
      password: "secret",
    },
  ]);
  assert.deepEqual(parseProxyList("HTTPS onlyuser@proxy.example.com:443"), [
    {
      type: "https",
      host: "proxy.example.com",
      port: 443,
      username: "onlyuser",
      password: "",
    },
  ]);
  assert.deepEqual(parseProxyList("PROXY %ZZ:bad%2@127.0.0.1:8080"), [
    {
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      username: "%ZZ",
      password: "bad%2",
    },
  ]);
  assert.deepEqual(parseProxyList("PROXY bad:0; PROXY bad:70000"), [
    { type: "direct" },
  ]);
});

test("describeProxy masks credentials and never exposes username or password", () => {
  const httpDesc = describeProxy({
    type: "http",
    host: "127.0.0.1",
    port: 7890,
    username: "alice",
    password: "super-secret-password",
  });
  assert.ok(!httpDesc.includes("alice"));
  assert.ok(!httpDesc.includes("super-secret-password"));
  assert.equal(httpDesc, "HTTP 代理 ***@127.0.0.1:7890");

  const dirtyDesc = describeProxy({
    type: "socks5",
    host: "bob:secret@[::1]",
    port: 1080,
  });
  assert.ok(!dirtyDesc.includes("bob"));
  assert.ok(!dirtyDesc.includes("secret"));
  assert.equal(dirtyDesc, "SOCKS5 代理 ***@[::1]:1080");

  assert.equal(describeProxy({ type: "direct" }), "直连");
  assert.equal(
    describeProxy({ type: "https", host: "proxy.example.com", port: 443 }),
    "HTTPS 代理 proxy.example.com:443",
  );
});

test("openTunnel sends Basic Proxy-Authorization for HTTP CONNECT and reports 407 clearly", async (t) => {
  const upstream = net.createServer((sock) => {
    sock.on("data", (chunk) => sock.write(chunk));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());

  const seenAuth = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, client, head) => {
    seenAuth.push(req.headers["proxy-authorization"] || "");
    if (
      req.headers["proxy-authorization"] !==
      `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`
    ) {
      client.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n",
      );
      client.destroy();
      return;
    }
    const [host, port] = req.url.split(":");
    const remote = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    });
    remote.on("error", () => client.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => proxy.close());

  const proxyPort = proxy.address().port;
  const target = { host: "127.0.0.1", port: upstream.address().port };

  await assert.rejects(
    openTunnel(
      { type: "http", host: "127.0.0.1", port: proxyPort },
      target,
      3000,
    ),
    /代理需要认证或账密无效/,
  );

  const [authed] = parseProxyList(`PROXY alice:s3cr3t@127.0.0.1:${proxyPort}`);
  const tunnel = await openTunnel(authed, target, 3000);
  t.after(() => tunnel.destroy());
  const echoed = await new Promise((resolve) => {
    tunnel.once("data", (buf) => resolve(buf.toString("utf8")));
    tunnel.write("ping");
  });
  assert.equal(echoed, "ping");
  assert.equal(
    seenAuth[1],
    `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`,
  );
});

test("openTunnel forces ALPNProtocols http/1.1 when connecting to an HTTPS proxy", async (t) => {
  const origConnect = tls.connect;
  const captured = [];
  tls.connect = (opts) => {
    captured.push(opts);
    const sock = new net.Socket();
    queueMicrotask(() => {
      sock.emit("secureConnect");
      queueMicrotask(() => {
        sock.emit(
          "data",
          Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"),
        );
      });
    });
    sock.write = () => true;
    sock.destroy = () => sock;
    return sock;
  };
  t.after(() => {
    tls.connect = origConnect;
  });

  const [httpsProxy] = parseProxyList("HTTPS alice:pw@proxy.example.com:443");
  const sock = await openTunnel(
    httpsProxy,
    { host: "target.example.com", port: 443 },
    3000,
  );
  sock.destroy();
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].ALPNProtocols, ["http/1.1"]);
  assert.equal(captured[0].servername, "proxy.example.com");
});

test("openTunnel supports SOCKS5 RFC 1929 username/password sub-negotiation and rejects bad auth", async (t) => {
  const upstream = net.createServer((sock) => {
    sock.on("data", (chunk) => sock.write(chunk));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());

  const methodsSeen = [];
  const authSeen = [];
  const socksServer = net.createServer((client) => {
    client.once("data", (greeting) => {
      methodsSeen.push([...greeting]);
      const nMethods = greeting[1];
      const methods = greeting.subarray(2, 2 + nMethods);
      if (!methods.includes(0x02)) {
        client.write(Buffer.from([0x05, 0xff]));
        client.end();
        return;
      }
      client.write(Buffer.from([0x05, 0x02]));
      client.once("data", (authBuf) => {
        const ver = authBuf[0];
        const ulen = authBuf[1];
        const user = authBuf.subarray(2, 2 + ulen).toString("utf8");
        const plen = authBuf[2 + ulen];
        const pass = authBuf
          .subarray(3 + ulen, 3 + ulen + plen)
          .toString("utf8");
        authSeen.push({ ver, user, pass });
        if (ver !== 0x01 || user !== "user1" || pass !== "pass@1") {
          client.write(Buffer.from([0x01, 0x01]));
          client.end();
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
        client.once("data", (req) => {
          const atyp = req[3];
          assert.equal(atyp, 0x03);
          const hlen = req[4];
          const host = req.subarray(5, 5 + hlen).toString("utf8");
          const port = req.readUInt16BE(5 + hlen);
          const remote = net.connect(port, host, () => {
            client.write(
              Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            );
            remote.pipe(client);
            client.pipe(remote);
          });
          remote.on("error", () => client.destroy());
        });
      });
    });
  });
  await new Promise((r) => socksServer.listen(0, "127.0.0.1", r));
  t.after(() => socksServer.close());

  const socksPort = socksServer.address().port;
  const target = { host: "127.0.0.1", port: upstream.address().port };

  // 无账密只报 0x00，服务端拒绝 (0xff)
  await assert.rejects(
    openTunnel(
      { type: "socks5", host: "127.0.0.1", port: socksPort },
      target,
      3000,
    ),
    /SOCKS5 代理/,
  );
  assert.deepEqual(methodsSeen[0], [0x05, 0x01, 0x00]);

  // 错误账密报认证失败
  const [badSocks] = parseProxyList(
    `SOCKS5 user1:wrong@127.0.0.1:${socksPort}`,
  );
  await assert.rejects(openTunnel(badSocks, target, 3000), /认证失败/);
  assert.deepEqual(methodsSeen[1], [0x05, 0x02, 0x00, 0x02]);

  // 正确账密完成 RFC 1929 协商并建立隧道
  const [goodSocks] = parseProxyList(
    `SOCKS5 user1:pass%401@127.0.0.1:${socksPort}`,
  );
  const tunnel = await openTunnel(goodSocks, target, 3000);
  t.after(() => tunnel.destroy());
  const reply = await new Promise((resolve) => {
    tunnel.once("data", (buf) => resolve(buf.toString("utf8")));
    tunnel.write("hello-socks5");
  });
  assert.equal(reply, "hello-socks5");
  assert.deepEqual(authSeen[1], { ver: 1, user: "user1", pass: "pass@1" });
});

test("createAgentFetch uses injected directFetch when no proxy agent is needed", async (t) => {
  const directCalls = [];
  const directFetch = async (input, init) => {
    directCalls.push({ url: String(input), method: init?.method || "GET" });
    return new Response("direct-ok", { status: 200 });
  };
  const agentFetch = createAgentFetch(async () => undefined, { directFetch });
  const res = await agentFetch("https://example.com/ping", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "direct-ok");
  assert.deepEqual(directCalls, [
    { url: "https://example.com/ping", method: "POST" },
  ]);

  // 有代理 agent 时走 agent 路径，支持 Headers 实例
  const srv = http.createServer((req, res2) => {
    res2.writeHead(200, { "x-custom-hdr": req.headers["x-test"] || "" });
    res2.end("proxied");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const agent = new http.Agent();
  t.after(() => agent.destroy());
  const proxiedFetch = createAgentFetch(async () => agent, { directFetch });
  const res2 = await proxiedFetch(`http://127.0.0.1:${srv.address().port}/ok`, {
    headers: new Headers({ "x-test": "yes" }),
  });
  assert.equal(res2.headers.get("x-custom-hdr"), "yes");
  assert.equal(await res2.text(), "proxied");
  assert.equal(directCalls.length, 1);
  assert.equal(createProxyAgent(parseProxyList("DIRECT")), undefined);
});
