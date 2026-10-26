# ChisaBot 中文部署包

此目录提供中文品牌、示例模型配置和两个部署共享技能。从 `server/` 启动时，设置 `TENANT_PACKAGE_DIR=../examples/zh-CN`；前端配置生成和部署应使用同一个部署包。

- `brand.yaml`：`product_name` 是展示名称；`tenant.id` 保留为 `chisabot`，兼容已有数据。
- `agents.yaml` / `channels.yaml`：默认为空。每个人第一次进来会自动得到一个私有的「助手」，其他机器人自己新建。
- `skills.yaml`：部署共享技能（公开信息研究、核实说法）。包里删掉的技能会在下次启动时从部署里移除（只移除包自己的，用户自己写的不动）。
- `model.yaml`：启动示例。实际协议、API 地址、密钥和默认模型在 设置 → 模型 配置；接入 Magpie 后，模型列表来自网关目录。

不要将真实密钥、登录密码或私人服务器地址写入此目录。

参考：[快速开始](../../docs/getting-started.md) · [模型配置](../../docs/models.md) · [Magpie 集成](../../docs/magpie.md)
