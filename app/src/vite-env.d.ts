/// <reference types="vite/client" />

// Vite's own ambient types, which is where `import.meta.glob` is declared. Needed because the
// component gallery discovers its files rather than listing them (see lib/copilot/gallery-registry).

interface ImportMetaEnv {
  /** 本次构建号（镜像标签），见 lib/version.ts。开发环境没有。 */
  readonly VITE_CHISABOT_BUILD_ID?: string;
  readonly VITE_MAGPIE_MANAGEMENT_URL?: string;
  /** 构建时默认打开长对话虚拟化（jank P3-3，只给性能对比用；用户侧仍以 localStorage / URL 为准）。 */
  readonly VITE_VIRTUAL_TRANSCRIPT?: string;
}
