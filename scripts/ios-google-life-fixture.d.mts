import type { NativeAuth } from "../apps/server/src/native-auth.ts";
import type { NativeLifeApplication, NativeLifeAuthority } from "../apps/server/src/native-life.ts";

export interface IOSGoogleLifeFixture {
  nativeLife: NativeLifeAuthority;
  lifeApplication: NativeLifeApplication;
  connectionIds: { calendar: string; gmail: string };
  control: {
    chatEvidence(): { plans: number; conversations: number; records: number; tasks: number };
    bodyReads(): Record<string, number>;
    heldReadStarted(): number;
    heldReadCompleted(): number;
    heldHandled(): number;
    releaseHeld(): void;
    failNextServerCloseForTest(): void;
  };
  close(): Promise<void>;
}

export function createIOSGoogleLifeFixture(options: {
  directory: string;
  nativeAuth: NativeAuth;
  grantedClientIds: string[];
}): Promise<IOSGoogleLifeFixture>;
