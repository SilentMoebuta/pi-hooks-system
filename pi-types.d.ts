interface UiApi {
  notify(message: string, level: string): void;
  confirm(message: string, options?: any): Promise<boolean>;
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    cwd: string;
    ui: UiApi;
    hasUI: boolean;
    signal: AbortSignal;
  }

  export interface ExtensionAPI {
    on(event: string, callback: (event: any, ctx: ExtensionContext) => any): any;
    sendMessage(message: any, options?: any): void;
    appendEntry(key: string, value: any): void;
    getEntry(key: string): any;
    exec(cmd: string, args?: string[], options?: any): Promise<any>;
    isProjectTrusted(cwd?: string): boolean | undefined;
  }
}
