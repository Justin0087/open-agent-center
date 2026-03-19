declare module "sql.js" {
  export interface SqlJsStatement {
    bind(values: Record<string, unknown>): void;
    run(values?: Record<string, unknown>): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: Record<string, unknown>): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayLike<number>) => SqlJsDatabase;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}