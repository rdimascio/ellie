import type { LifeStore } from "../packages/life-core/src/index.ts";
import type { TaskRuntime } from "../packages/task-runtime/src/index.ts";

export interface IOSQuietLifeFixture {
  sessionID: string;
  taskID: string;
  control: {
    armDetail(): void;
    releaseDetail(): void;
    detailStarted(): number;
    detailSettled(): number;
    armChatResponse(): void;
    releaseChatResponse(): void;
    chatResponseHeld(): number;
    chatResponseReleased(): number;
    nativeChatPosts(): number;
    durableTurns(): number;
  };
  releaseAll(): void;
}

export function createIOSQuietLifeFixture(options: {
  life: LifeStore;
  tasks: TaskRuntime;
  actorId: string;
}): Promise<IOSQuietLifeFixture>;
