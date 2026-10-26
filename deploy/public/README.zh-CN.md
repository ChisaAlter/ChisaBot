# ChisaBot HTTPS 网页登录

此模板使用同一域名的两个 HTTPS 入口：`https://chisabot.example.com:8443` 是 ChisaBot，`:2053` 是 Magpie 管理页。将 `nginx.conf` 中所有 `chisabot.example.com` 替换为自己的域名，包括 Origin 白名单、Host 校验、证书路径与 Magpie 登录来源映射；此处没有真实部署域名和凭据。

后端和登录服务只监听 loopback。匿名页面跳转 `/login`，匿名 API 返回 JSON 401；跨站写入、外站 Origin 和缺少 Origin 的 WebSocket 被拒绝。聊天 SSE 不缓存、不缓冲；原认证、Cookie、内部路由和容器名继续使用 `chisabot` 兼容标识。

## 初始化认证配置

先按 [主部署说明](../README.zh-CN.md) 构建 `local/chisabot:latest`。以下命令在此目录的 Bash 中执行，用户名和 HTTPS Origin 可以自行填写，密码从不回显或放入命令参数：

```sh
install -d -o 1002 -g 1002 -m 700 auth-data
chmod 755 auth
read -r -p '管理员账号: ' CHISABOT_AUTH_USER
read -r -p 'ChisaBot HTTPS Origin（含端口）: ' CHISABOT_PUBLIC_ORIGIN
read -r -s -p '管理员密码: ' CHISABOT_AUTH_PASSWORD
printf '\n'
export CHISABOT_AUTH_USER CHISABOT_PUBLIC_ORIGIN
printf '%s' "$CHISABOT_AUTH_PASSWORD" | docker run --rm -i --user 0:0 \
  --entrypoint /usr/local/bin/bun --env CHISABOT_AUTH_USER --env CHISABOT_PUBLIC_ORIGIN \
  --mount "type=bind,source=$(pwd)/auth,target=/auth" local/chisabot:latest -e '
  const fs=require("node:fs");const password=await new Response(Bun.stdin).text();
  const username=process.env.CHISABOT_AUTH_USER;const origin=process.env.CHISABOT_PUBLIC_ORIGIN;
  if(!username||username.length>64||!password||password.length>1024||new URL(origin).protocol!=="https:")throw new Error("Invalid authentication input");
  await Bun.write("/auth/config.json",JSON.stringify({username,passwordHash:await Bun.password.hash(password,{algorithm:"argon2id"}),publicOrigin:new URL(origin).origin}));
  fs.chownSync("/auth/config.json",0,1002);fs.chmodSync("/auth/config.json",0o640);'
unset CHISABOT_AUTH_PASSWORD
```

若使用自定义镜像名，以上及下文的 `local/chisabot:latest` 换成自己的 `CHISABOT_IMAGE`。已有安装不应覆盖认证配置，修改账号或密码哈希会使旧会话失效。

密码仅保存 Argon2id 哈希。登录配置 `auth/config.json` 权限为 `root:1002`、`0640`，会话目录 `auth-data/` 为 `1002:1002`、`0700`。随机 32 字节令牌只保存 SHA-256 哈希；Cookie 使用 Secure、HttpOnly、SameSite=Lax。普通会话最长 12 小时，记住登录 30 天；连续失败暂停及并发密码校验限制保留。

## Magpie 私密代理配置

Nginx 要求存在 `magpie-private.conf`。未启用 Magpie 时先创建空 Cookie 配置：

```sh
umask 077
printf 'proxy_set_header Cookie "";\n' > magpie-private.conf
```

启用 [Magpie 模板](../magpie.compose.yaml) 后，从私密 env 文件读取仅允许十六进制字符的 Web key，生成代理配置，不打印密钥：

```sh
magpie_web_key=$(sed -n 's/^MAGPIE_WEB_KEY=//p' ../private/magpie.env | tr -d '\r')
case "$magpie_web_key" in ''|*[!0-9a-fA-F]*) echo 'Invalid Magpie web key.' >&2; exit 1 ;; esac
umask 077
printf 'proxy_set_header Cookie "magpie_web_3430=%s";\n' "$magpie_web_key" > magpie-private.conf
unset magpie_web_key
```

Web key 必须与 Magpie 的 `MAGPIE_WEB_KEY` 一致。`magpie-private.conf`、`auth/config.json`、`auth-data/` 都被 Git 忽略。浏览器 Cookie、Authorization 不直接透传到 Magpie；网关只注入这份私密管理 Cookie，并隐藏上游 Set-Cookie。管理入口 `/v1` 和 `/v1beta` 被封闭，模型 API 仅经 Docker 网络或 loopback 访问。

## 证书与启动

证书需已有 `/etc/letsencrypt/live/自己的域名/{fullchain.pem,privkey.pem}`。挂载整个证书根目录，包括 live 和 archive，以保证续期符号链接可解析；如实际目录不同，在 `../.env` 中设置 `CHISABOT_CERT_DIRECTORY`。镜像默认为 `nginx:alpine`，可用 `CHISABOT_NGINX_IMAGE` 固定自己的版本或 digest。

```sh
docker compose --env-file ../.env -p chisabot-public -f compose.yaml config --quiet
docker compose --env-file ../.env -p chisabot-public -f compose.yaml run --rm --no-deps gateway nginx -t
docker compose --env-file ../.env -p chisabot-public -f compose.yaml up -d --wait
```

认证服务复用本地 ChisaBot 镜像，`pull_policy: never`，不需要私有的预存镜像 SHA。公网仅开放自己的 HTTPS 端口，保留其他站点的端口及配置。配置文件中的 Origin 必须与 `auth/config.json` 完全一致；两个入口使用同一 hostname，Cookie 才能共用。

```sh
docker exec chisabot-web-auth bun test /auth/server.test.ts /auth/startup-report.test.ts
docker exec chisabot-public-gateway nginx -t
sh reload-cert.sh
```

证书重载脚本先校验配置再 reload；可安装此目录的兼容 systemd timer，但要先把 service 内的 `/opt/chisabot-zh/public` 改为实际路径。备份应包含应用 Docker 卷、主 `.env`、Magpie 私密目录与数据、登录配置及 SQLite 数据。SQLite 使用备份接口或停登录服务后复制，不应只复制正在写入的主数据库文件。
