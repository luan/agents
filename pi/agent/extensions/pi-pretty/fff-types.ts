type FffOk<T> = { ok: true; value: T };
type FffErr = { ok: false; error: string };

export type FffResult<T> = FffOk<T> | FffErr;

export interface FffGrepCursor {
  [key: string]: unknown;
}

export interface FffFileItem {
  relativePath: string;
}

export interface FffSearchResult {
  items: FffFileItem[];
  totalMatched: number;
}

export interface FffGrepMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FffGrepResult {
  items: FffGrepMatch[];
  nextCursor?: FffGrepCursor | null;
  regexFallbackError?: string | null;
}

export interface FffHealthStatus {
  version: string;
  git: {
    repositoryFound: boolean;
    workdir?: string | null;
  };
  filePicker: {
    initialized: boolean;
    indexedFiles?: number | null;
  };
  frecency: {
    initialized: boolean;
  };
  queryTracker: {
    initialized: boolean;
  };
}

export interface FffScanProgress {
  isScanning: boolean;
  scannedFilesCount: number;
}

export interface FffFinderLike {
  isDestroyed: boolean;
  waitForScan(timeoutMs: number): Promise<FffResult<boolean>>;
  destroy(): void;
  fileSearch(
    query: string,
    options: { pageSize: number },
  ): FffResult<FffSearchResult>;
  grep(
    query: string,
    options: {
      mode: "plain" | "regex";
      smartCase: boolean;
      maxMatchesPerFile: number;
      cursor: FffGrepCursor | null;
      beforeContext: number;
      afterContext: number;
    },
  ): FffResult<FffGrepResult>;
  multiGrep(options: {
    patterns: string[];
    constraints?: string;
    maxMatchesPerFile: number;
    smartCase: boolean;
    cursor: FffGrepCursor | null;
    beforeContext: number;
    afterContext: number;
  }): FffResult<FffGrepResult>;
  healthCheck(): FffResult<FffHealthStatus>;
  getScanProgress(): FffResult<FffScanProgress>;
  scanFiles(): FffResult<unknown>;
}

export interface FffModuleLike {
  FileFinder: {
    create(options: {
      basePath: string;
      frecencyDbPath: string;
      historyDbPath: string;
      aiMode: boolean;
    }): FffResult<FffFinderLike>;
  };
}
