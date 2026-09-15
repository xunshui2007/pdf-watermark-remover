/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 仓库地址，用于页头「源码 / 说明」链接（构建时可用 VITE_REPO_URL 覆盖） */
  readonly VITE_REPO_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
