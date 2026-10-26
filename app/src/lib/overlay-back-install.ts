import { installOverlayBack } from "./overlay-back";

/*
 * 必须在创建路由之前执行（main.tsx 里排在 `./router` 之前导入）：overlay-back 的 popstate 监听要排在
 * TanStack Router 的前面。路由收到 popstate 会同步渲染，那一帧里的副作用（例如按记忆把 `watch` 补回地址）
 * 得已经知道「这是一次返回」，才能不写地址、不压标记（CB-098 QA 第三轮）。
 */
installOverlayBack();
