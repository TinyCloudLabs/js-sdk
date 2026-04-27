declare module "@platformatic/vfs" {
  export interface VFSOptions {
    moduleHooks?: boolean;
    virtualCwd?: boolean;
    overlay?: boolean;
  }

  export class VirtualProvider {
    get readonly(): boolean;
  }

  export interface VirtualFileSystem {
    mount(prefix: string): this;
    unmount(): void;
  }

  export function create(provider?: VirtualProvider, options?: VFSOptions): VirtualFileSystem;
}
