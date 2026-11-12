import type { MonaBridge } from "../shared/contracts/bridge";

declare global {
  interface Window {
    mona: MonaBridge;
  }
}

export {};
