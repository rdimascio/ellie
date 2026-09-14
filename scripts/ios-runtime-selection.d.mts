export type SimulatorRuntime = {
  identifier: string;
  version: string;
  isAvailable: boolean;
  supportedDeviceTypes?: Array<{
    identifier: string;
    name: string;
    productFamily: string;
  }>;
};
export function parseAppleVersion(value: unknown): [number, number, number];
export function selectCompatibleIOSRuntime(runtimes: unknown, sdkVersion: string): SimulatorRuntime;
