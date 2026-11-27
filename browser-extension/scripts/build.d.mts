export interface BuildExtensionResult {
  distDir: string;
  zipPath: string;
  zipBytes: number;
  version: string;
  files: string[];
}

export function buildExtension(): Promise<BuildExtensionResult>;
