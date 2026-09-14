import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectActivationPolicyBlob,
  readActivationPolicyBuildFile,
} from "../scripts/activation-policy-source.mjs";

const authority = Buffer.from("ELLIE-ACTIVATION-POLICY-UNAVAILABLE-V1\n");
const putName = (b: Buffer, at: number, name: string) => b.write(name, at, 16, "ascii");
function thin(arch: "arm64" | "x64") {
  const commandBytes = 152,
    offset = 32 + commandBytes,
    b = Buffer.alloc(offset + authority.length);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  b.writeUInt32LE(arch === "arm64" ? 0 : 3, 8);
  b.writeUInt32LE(2, 12);
  b.writeUInt32LE(1, 16);
  b.writeUInt32LE(commandBytes, 20);
  b.writeUInt32LE(0, 24);
  b.writeUInt32LE(0, 28);
  b.writeUInt32LE(0x19, 32);
  b.writeUInt32LE(commandBytes, 36);
  putName(b, 40, "__TEXT");
  b.writeBigUInt64LE(0x100000000n, 56);
  b.writeBigUInt64LE(BigInt(b.length), 64);
  b.writeBigUInt64LE(0n, 72);
  b.writeBigUInt64LE(BigInt(b.length), 80);
  b.writeUInt32LE(5, 88);
  b.writeUInt32LE(5, 92);
  b.writeUInt32LE(1, 96);
  putName(b, 104, "__ellie_policy");
  putName(b, 120, "__TEXT");
  b.writeBigUInt64LE(0x100000000n + BigInt(offset), 136);
  b.writeBigUInt64LE(BigInt(authority.length), 144);
  b.writeUInt32LE(offset, 152);
  authority.copy(b, offset);
  return b;
}

function withOverlappingSegment(segmentName: string) {
  const original = thin("arm64");
  const policyOffset = 32 + 152 + 72;
  const result = Buffer.alloc(policyOffset + authority.length);
  original.copy(result, 0, 0, 32 + 152);
  authority.copy(result, policyOffset);
  result.writeUInt32LE(2, 16);
  result.writeUInt32LE(224, 20);
  result.writeBigUInt64LE(BigInt(result.length), 64);
  result.writeBigUInt64LE(BigInt(result.length), 80);
  result.writeBigUInt64LE(0x100000000n + BigInt(policyOffset), 136);
  result.writeUInt32LE(policyOffset, 152);
  result.writeUInt32LE(0x19, 184);
  result.writeUInt32LE(72, 188);
  putName(result, 192, segmentName);
  result.writeBigUInt64LE(0x100000000n, 208);
  result.writeBigUInt64LE(BigInt(result.length), 216);
  result.writeBigUInt64LE(0n, 224);
  result.writeBigUInt64LE(BigInt(result.length), 232);
  result.writeUInt32LE(5, 240);
  result.writeUInt32LE(5, 244);
  return result;
}

test("thin Mach-O policy audit accepts only the closed section boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-policy-thin-"));
  let completed = false;
  let failed = false;
  const check = (name: string, body: () => Promise<unknown>) =>
    t.test(name, async () => {
      try {
        await body();
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  t.after(async () => {
    if (completed) await rm(root, { recursive: true });
  });
  async function audit(
    name: string,
    b: Buffer,
    arch: "arm64" | "x64" = "arm64",
    expected = authority,
  ) {
    const p = join(root, name);
    await writeFile(p, b, { mode: 0o600 });
    return inspectActivationPolicyBlob(p, arch, expected);
  }
  assert.deepEqual(await audit("arm", thin("arm64")), authority);
  assert.deepEqual(await audit("x64", thin("x64"), "x64"), authority);
  const cases: Array<[string, (b: Buffer) => void]> = [
    ["32-bit", (b) => b.writeUInt32LE(0xfeedface, 0)],
    ["fat", (b) => b.writeUInt32LE(0xcafebabe, 0)],
    ["swapped", (b) => b.writeUInt32LE(0xcffaedfe, 0)],
    ["wrong-kind", (b) => b.writeUInt32LE(1, 12)],
    ["cpu", (b) => b.writeUInt32LE(0x01000007, 4)],
    ["subtype-capability", (b) => b.writeUInt32LE(0x80000000, 8)],
    ["subtype", (b) => b.writeUInt32LE(3, 8)],
    ["reserved", (b) => b.writeUInt32LE(1, 28)],
    ["ncmd-overflow", (b) => b.writeUInt32LE(129, 16)],
    ["ncmd", (b) => b.writeUInt32LE(0, 16)],
    ["sizeofcmds-overflow", (b) => b.writeUInt32LE(1024 * 1024 + 1, 20)],
    ["sizeofcmds", (b) => b.writeUInt32LE(151, 20)],
    ["cmdsize-misaligned", (b) => b.writeUInt32LE(151, 36)],
    ["cmdsize", (b) => b.writeUInt32LE(72, 36)],
    ["text-max-write", (b) => b.writeUInt32LE(7, 88)],
    ["text-not-executable", (b) => b.writeUInt32LE(1, 92)],
    ["32-bit-segment", (b) => b.writeUInt32LE(1, 32)],
    ["text-write", (b) => b.writeUInt32LE(7, 92)],
    ["highvm", (b) => b.writeUInt32LE(1, 100)],
    ["wrong-section", (b) => putName(b, 120, "__DATA")],
    [
      "section-over-header",
      (b) => {
        b.writeUInt32LE(32, 152);
        b.writeBigUInt64LE(0x100000020n, 136);
      },
    ],
    ["address", (b) => b.writeBigUInt64LE(1n, 136)],
    ["size-zero", (b) => b.writeBigUInt64LE(0n, 144)],
    ["alignment", (b) => b.writeUInt32LE(1, 156)],
    ["relocation-count", (b) => b.writeUInt32LE(1, 164)],
    ["relocation", (b) => b.writeUInt32LE(1, 160)],
    ["flags", (b) => b.writeUInt32LE(1, 168)],
    ["section-reserved2", (b) => b.writeUInt32LE(1, 176)],
    ["section-reserved", (b) => b.writeUInt32LE(1, 172)],
    [
      "tamper",
      (b) => {
        b[b.length - 1] = b[b.length - 1]! ^ 1;
      },
    ],
    [
      "padded-name",
      (b) => {
        b[47] = 0;
        b[48] = 0x41;
      },
    ],
    [
      "high-bit-name",
      (b) => {
        b[40] = 0xdf;
      },
    ],
    [
      "high-bit-section-name",
      (b) => {
        b[104] = 0xdf;
      },
    ],
    ["debug-flags", (b) => b.writeUInt32LE(0x02000000, 168)],
    ["file-end-overflow", (b) => b.writeBigUInt64LE(0xffffffffffffffffn, 80)],
    ["vm-end-overflow", (b) => b.writeBigUInt64LE(0xffffffffffffffffn, 64)],
    ["section-outside", (b) => b.writeUInt32LE(b.length + 1, 152)],
    ["instruction-flags", (b) => b.writeUInt32LE(0x80000400, 168)],
    ["reserved3", (b) => b.writeUInt32LE(1, 180)],
  ];
  for (const [name, mutate] of cases)
    await check(name, async () => {
      const b = thin("arm64");
      mutate(b);
      await assert.rejects(audit(name, b), name);
    });
  await check("truncated-header", () =>
    assert.rejects(audit("truncated-header", thin("arm64").subarray(0, 16))),
  );
  await check("truncated", () =>
    assert.rejects(audit("truncated", thin("arm64").subarray(0, 100))),
  );
  await check("short-expected", () =>
    assert.rejects(audit("short-expected", thin("arm64"), "arm64", authority.subarray(1))),
  );
  await check("section-trailing", async () => {
    const b = Buffer.concat([thin("arm64"), Buffer.from([0x0a])]);
    b.writeBigUInt64LE(BigInt(authority.length + 1), 144);
    b.writeBigUInt64LE(BigInt(b.length), 64);
    b.writeBigUInt64LE(BigInt(b.length), 80);
    await assert.rejects(audit("section-trailing", b));
  });
  await check("duplicate-text-segment", () =>
    assert.rejects(
      audit(
        "duplicate-text-segment",
        (() => {
          const b = withOverlappingSegment("__TEXT");
          b.writeBigUInt64LE(0n, 216);
          b.writeBigUInt64LE(0n, 232);
          return b;
        })(),
      ),
    ),
  );
  await check("overlapping-segments", () =>
    assert.rejects(audit("overlapping-segments", withOverlappingSegment("__DATA"))),
  );
  await check("duplicate-policy-section", async () => {
    const original = thin("arm64"),
      offset = 32 + 72 + 160;
    const b = Buffer.alloc(offset + authority.length);
    original.copy(b, 0, 0, 184);
    original.copy(b, 184, 104, 184);
    authority.copy(b, offset);
    b.writeUInt32LE(232, 20);
    b.writeUInt32LE(232, 36);
    b.writeUInt32LE(2, 96);
    b.writeBigUInt64LE(BigInt(b.length), 64);
    b.writeBigUInt64LE(BigInt(b.length), 80);
    for (const section of [104, 184]) {
      b.writeBigUInt64LE(0x100000000n + BigInt(offset), section + 32);
      b.writeUInt32LE(offset, section + 48);
    }
    await assert.rejects(audit("duplicate-policy-section", b));
  });
  completed = !failed;
});

test("policy compiler reads reject unsafe files and invalid allocation bounds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-policy-read-"));
  let completed = false;
  t.after(async () => {
    if (completed) await rm(root, { recursive: true });
  });
  const source = join(root, "source");
  await writeFile(source, authority, { mode: 0o400, flag: "wx" });
  assert.deepEqual((await readActivationPolicyBuildFile(source, 1024, 0o400)).data, authority);
  for (const maximum of [0, -1, NaN, Infinity, 64 * 1024 * 1024 + 1])
    await assert.rejects(readActivationPolicyBuildFile(source, maximum, 0o400));
  await assert.rejects(readActivationPolicyBuildFile("relative", 1024, 0o400));
  await assert.rejects(readActivationPolicyBuildFile(source, 1024, 0o777));
  await assert.rejects(readActivationPolicyBuildFile(source, 1024, 0o600));
  const linked = join(root, "linked");
  await symlink(source, linked);
  await assert.rejects(readActivationPolicyBuildFile(linked, 1024, 0o400));
  const hardlinked = join(root, "hardlinked");
  await link(source, hardlinked);
  await assert.rejects(readActivationPolicyBuildFile(source, 1024, 0o400));
  await rm(hardlinked);
  await chmod(source, 0o600);
  await truncate(source, 1025);
  await chmod(source, 0o400);
  await assert.rejects(readActivationPolicyBuildFile(source, 1024, 0o400));
  completed = true;
});
