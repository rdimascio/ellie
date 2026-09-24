import type { NativeAuth } from "../apps/server/src/native-auth.ts";
import type { NativeLifeApplication, NativeLifeAuthority } from "../apps/server/src/native-life.ts";
import type { IOSQuietLifeFixture } from "./ios-quiet-life-fixture.mjs";

export interface IOSGoogleLifeFixture {
  nativeLife: NativeLifeAuthority;
  lifeApplication: NativeLifeApplication;
  connectionIds: { calendar: string; gmail: string };
  quiet?: IOSQuietLifeFixture;
  control: {
    chatEvidence(): { plans: number; conversations: number; records: number; tasks: number };
    bodyReads(): Record<string, number>;
    heldReadStarted(): number;
    heldReadCompleted(): number;
    heldHandled(): number;
    armCalendarChangeAfterNextList(): void;
    calendarChanges(): number;
    releaseHeld(): void;
    failNextServerCloseForTest(): void;
  };
  close(): Promise<void>;
}

export function createIOSGoogleLifeFixture(options: {
  directory: string;
  nativeAuth: NativeAuth;
  grantedClientIds: string[];
  quiet?: boolean;
}): Promise<IOSGoogleLifeFixture>;
